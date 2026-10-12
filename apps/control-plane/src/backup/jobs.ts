// One backup of a project, one backup of the platform database, one restore into a new project
// (deploy/platform/SPEC.md §19). The tools run in this container: restic, pg_dump, pg_restore,
// psql (Postgres 17 clients; they read and write the projects' Postgres 15) and mc.

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { forgetArgs, resticEnv, type Policy } from './config.ts'
import { lastError, must, type Exec } from './exec.ts'
import { benignRestoreError, filterRoles, filterToc, rewriteProjectRef } from './restore-plan.ts'
import { lifecycleRule } from './s3.ts'

export type JobDeps = {
  exec: Exec
  stageDir: string
  projectsHostDir: string
  domainSuffix: string
  minio: { url: string; rootUser: string; rootPassword: string }
  platformDb: { host: string; password: string }
  log: (event: string, fields: Record<string, unknown>) => void
}

export type Snapshot = { id: string; time: string; size_bytes: number | null }

/** A project's Postgres as the backup service reaches it on the `coolify` network. */
export type ProjectDb = { host: string; password: string }

const KEY_FILE = '/etc/postgresql-custom/pgsodium_root.key'
const SUPERUSER = 'supabase_admin'

function pgEnv(db: ProjectDb, user = SUPERUSER): Record<string, string> {
  return { PGHOST: db.host, PGPORT: '5432', PGUSER: user, PGPASSWORD: db.password, PGDATABASE: 'postgres', PGCONNECT_TIMEOUT: '10' }
}

function mcEnv(deps: JobDeps): Record<string, string> {
  const url = new URL(deps.minio.url)
  url.username = encodeURIComponent(deps.minio.rootUser)
  url.password = encodeURIComponent(deps.minio.rootPassword)
  return { MC_HOST_platform: url.toString().replace(/\/+$/, ''), MC_CONFIG_DIR: join(deps.stageDir, '.mc') }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

function restic(deps: JobDeps, policy: Policy, args: string[]) {
  return deps.exec('restic', ['-r', policy.repository, '-o', 's3.bucket-lookup=path', ...args], {
    env: { ...resticEnv(policy.destination, policy.password), RESTIC_CACHE_DIR: join(deps.stageDir, '.cache') },
  })
}

/** Creates the repository on first use, and refuses a destination that deletes old files. */
async function ensureRepository(deps: JobDeps, policy: Policy, id: string): Promise<void> {
  const config = await restic(deps, policy, ['cat', 'config'])
  if (config.code !== 0) {
    if (!/Is there a repository|does not exist|unable to open config|config file.*not found|no such file/i.test(config.stderr))
      throw new Error(`Destination ${policy.destinationName}: ${lastError(config.stderr)}`)
    const init = await restic(deps, policy, ['init'])
    if (init.code !== 0) throw new Error(`Destination ${policy.destinationName}: ${lastError(init.stderr)}`)
    deps.log('backup.repository_created', { id, destination: policy.destinationName })
  }
  const rule = await lifecycleRule(policy.destination, `${id}/config`).catch((err: unknown) => {
    deps.log('backup.lifecycle_check_failed', { id, error: String(err).slice(0, 200) })
    return null
  })
  if (rule)
    throw new Error(
      `Destination ${policy.destinationName} deletes old files (lifecycle rule "${rule}"), which would break every backup. Use a bucket or prefix without such a rule.`
    )
}

async function snapshot(deps: JobDeps, policy: Policy, id: string, paths: string[]) {
  await ensureRepository(deps, policy, id)
  const r = await restic(deps, policy, ['backup', '--json', '--host', 'platform', '--tag', `ref=${id}`, ...paths])
  if (r.code !== 0) throw new Error(`restic backup: ${lastError(r.stderr)}`)
  const summary = r.stdout
    .split('\n')
    .map((l) => {
      try {
        return JSON.parse(l) as { message_type?: string; snapshot_id?: string; total_bytes_processed?: number }
      } catch {
        return null
      }
    })
    .find((m) => m?.message_type === 'summary')
  const forget = await restic(deps, policy, ['forget', '--prune', '--host', 'platform', '--tag', `ref=${id}`, ...forgetArgs(policy.keep)])
  if (forget.code !== 0) deps.log('backup.forget_failed', { id, error: lastError(forget.stderr) })
  return { snapshotId: summary?.snapshot_id ?? null, sizeBytes: summary?.total_bytes_processed ?? null }
}

/** Database (with roles and the pgsodium key), Storage files and Studio's settings files of one project. */
export async function backupProject(deps: JobDeps, project: { ref: string }, db: ProjectDb, policy: Policy) {
  const { exec } = deps
  const base = join(deps.stageDir, project.ref)
  const dbDir = join(base, 'db')
  await rm(dbDir, { recursive: true, force: true })
  await mkdir(dbDir, { recursive: true, mode: 0o700 })
  await mkdir(join(base, 'storage'), { recursive: true, mode: 0o700 })

  const env = pgEnv(db)
  await must(exec, 'Dump roles', 'pg_dumpall', ['--roles-only', '-f', join(dbDir, 'roles.sql')], { env })
  await must(exec, 'Dump database', 'pg_dump', ['-Fc', '-Z0', '-f', join(dbDir, 'postgres.dump')], { env })
  const key = await must(exec, 'Read pgsodium key', 'psql', ['-At', '-c', `select pg_read_file('${KEY_FILE}')`], { env })
  await writeFile(join(dbDir, 'pgsodium_root.key'), key.stdout.trim(), { mode: 0o600 })

  // Incremental: only new and changed objects are downloaded; the copy here stays for next time.
  await must(exec, 'Copy Storage files', 'mc', ['mirror', '--overwrite', '--remove', '--quiet', `platform/${project.ref}`, join(base, 'storage')], {
    env: mcEnv(deps),
  })

  const settings = join(deps.projectsHostDir, project.ref)
  const paths = [dbDir, join(base, 'storage'), ...((await exists(settings)) ? [settings] : [])]
  const result = await snapshot(deps, policy, project.ref, paths)
  await rm(dbDir, { recursive: true, force: true })
  return result
}

/** The platform's own database: the project registry (secrets encrypted), Supavisor and Realtime tenants. */
export async function backupPlatform(deps: JobDeps, policy: Policy, id: string) {
  const dir = join(deps.stageDir, id)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const env = pgEnv(deps.platformDb, 'postgres')
  for (const database of ['_supabase', 'postgres']) {
    await must(deps.exec, `Dump platform database ${database}`, 'pg_dump', ['-Fc', '-Z0', '-d', database, '-f', join(dir, `${database}.dump`)], { env })
  }
  const result = await snapshot(deps, policy, id, [dir])
  await rm(dir, { recursive: true, force: true })
  return result
}

export async function listSnapshots(deps: JobDeps, policy: Policy, id: string): Promise<Snapshot[]> {
  const r = await restic(deps, policy, ['snapshots', '--json', '--host', 'platform', '--tag', `ref=${id}`])
  if (r.code !== 0) {
    if (/Is there a repository|does not exist|unable to open config/i.test(r.stderr)) return []
    throw new Error(`restic snapshots: ${lastError(r.stderr)}`)
  }
  const list = JSON.parse(r.stdout || '[]') as {
    id: string
    time: string
    summary?: { total_bytes_processed?: number }
  }[]
  return list
    .map((s) => ({ id: s.id, time: s.time, size_bytes: s.summary?.total_bytes_processed ?? null }))
    .sort((a, b) => (a.time < b.time ? 1 : -1))
}

export type RestoreTarget = {
  ref: string
  db: ProjectDb
  /** Restarts the new project's stack and resolves once its database answers again. */
  restart: () => Promise<void>
}

/**
 * Restores one snapshot of `sourceRef` into `target`, a project just created for it. The source
 * project is never touched. Returns what went wrong without stopping the restore (warnings).
 */
export async function restoreIntoProject(
  deps: JobDeps,
  policy: Policy,
  sourceRef: string,
  snapshotId: string,
  target: RestoreTarget,
  workId: string
): Promise<string[]> {
  const { exec } = deps
  const warnings: string[] = []
  const work = join(deps.stageDir, `restore-${workId}`)
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true, mode: 0o700 })
  try {
    const r = await restic(deps, policy, ['restore', snapshotId, '--target', work])
    if (r.code !== 0) throw new Error(`restic restore: ${lastError(r.stderr)}`)
    const dbDir = join(work, deps.stageDir, sourceRef, 'db')
    const storageDir = join(work, deps.stageDir, sourceRef, 'storage', sourceRef)
    const settingsDir = join(work, deps.projectsHostDir, sourceRef)
    const env = pgEnv(target.db)

    // 1. The encryption key Vault secrets were sealed with, and the settings files; both take
    //    effect when the stack restarts.
    const keyFile = join(dbDir, 'pgsodium_root.key')
    if (await exists(keyFile)) {
      const key = (await readFile(keyFile, 'utf8')).trim()
      if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('The pgsodium key in the backup is not 64 hex characters')
      const sql = [
        '\\set ON_ERROR_STOP 1',
        "select lo_from_bytea(0, convert_to(:'k', 'UTF8')) as o \\gset",
        `select lo_export(:o, '${KEY_FILE}');`,
        'select lo_unlink(:o);',
      ].join('\n')
      await must(exec, 'Write pgsodium key', 'psql', ['-q', '-At', '-v', `k=${key}`], { env, input: sql })
    }
    if (await exists(settingsDir)) {
      for (const sub of ['gotrue', 'storage', 'state']) {
        const from = join(settingsDir, sub)
        if (!(await exists(from))) continue
        const to = join(deps.projectsHostDir, target.ref, sub)
        await mkdir(to, { recursive: true })
        for (const name of await readdir(from)) {
          const text = await readFile(join(from, name), 'utf8')
          await writeFile(join(to, name), rewriteProjectRef(text, sourceRef, target.ref, deps.domainSuffix), {
            mode: sub === 'state' ? 0o600 : 0o644,
          })
        }
      }
    }
    await target.restart()

    // 2. Roles the new project lacks (an app's own login, say), then the database.
    const roles = await must(exec, 'List roles', 'psql', ['-At', '-c', 'select rolname from pg_roles'], { env })
    const rolesSql = filterRoles(await readFile(join(dbDir, 'roles.sql'), 'utf8'), new Set(roles.stdout.split('\n').filter(Boolean)))
    if (rolesSql) {
      const r2 = await exec('psql', ['-q', '-At'], { env, input: rolesSql })
      for (const line of r2.stderr.split('\n')) if (/ERROR/.test(line)) warnings.push(`roles: ${line.trim().slice(0, 300)}`)
    }
    const toc = await must(exec, 'Read dump', 'pg_restore', ['-l', join(dbDir, 'postgres.dump')])
    const list = join(work, 'restore.list')
    await writeFile(list, filterToc(toc.stdout), { mode: 0o600 })
    const restore = await exec('pg_restore', ['--clean', '--if-exists', '-d', 'postgres', '-L', list, join(dbDir, 'postgres.dump')], { env })
    for (const line of restore.stderr.split('\n')) {
      const m = /error: (?:could not execute query: )?(.*)/.exec(line)
      if (m && !benignRestoreError(m[1])) warnings.push(`database: ${m[1].trim().slice(0, 300)}`)
    }
    await exec('psql', ['-q', '-c', "notify pgrst, 'reload schema'"], { env })

    // 3. Storage files: keys start with the project's ref (storage-api's TENANT_ID).
    if (await exists(storageDir)) {
      await must(exec, 'Copy Storage files back', 'mc', ['mirror', '--overwrite', '--quiet', storageDir, `platform/${target.ref}/${target.ref}`], {
        env: mcEnv(deps),
      })
    }
    return warnings
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
