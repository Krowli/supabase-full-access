// Entry point of the backup container (deploy/platform/platform-compose.yaml, service `backup`).
// Same image as the control plane; see src/backup/service.ts.

import pg from 'pg'

import { createPgRegistry } from '../registry.ts'
import { parseSecretsKey } from '../secrets.ts'
import type { BaseBackup } from '../runner/walg.ts'
import { exec } from './exec.ts'
import type { PitrRunner } from './pitr.ts'
import { BackupService, type ConfigSource, type ControlPlaneClient } from './service.ts'
import { createRunStore, migrateRuns } from './state.ts'

const env = process.env
const missing: string[] = []
const req = (name: string) => {
  const v = env[name]
  if (!v) missing.push(name)
  return v ?? ''
}
const config = {
  registryDatabaseUrl: req('REGISTRY_DATABASE_URL'),
  secretsKey: req('PLATFORM_SECRETS_KEY'),
  apiToken: req('CONTROL_PLANE_TOKEN'),
  controlPlaneUrl: env.CONTROL_PLANE_URL ?? 'http://control-plane:8080',
  // Who restarts a project after a restore: Coolify (default) or the runner (STACK_BACKEND=runner).
  stackBackend: env.STACK_BACKEND || 'coolify',
  coolifyUrl: (env.STACK_BACKEND === 'runner' ? (env.COOLIFY_URL ?? '') : req('COOLIFY_URL')).replace(/\/+$/, ''),
  coolifyToken: env.STACK_BACKEND === 'runner' ? (env.COOLIFY_TOKEN ?? '') : req('COOLIFY_TOKEN'),
  resourceUuid: env.STACK_BACKEND === 'runner' ? '' : (env.COOLIFY_RESOURCE_UUID ?? ''),
  runnerUrl: (env.RUNNER_URL ?? 'http://runner:8080').replace(/\/+$/, ''),
  runnerToken: env.STACK_BACKEND === 'runner' ? req('RUNNER_TOKEN') : '',
  domainSuffix: req('PROJECT_DOMAIN_SUFFIX'),
  projectsHostDir: req('PROJECTS_HOST_DIR'),
  stageDir: env.STAGE_DIR ?? '/stage',
  minio: { url: env.MINIO_URL ?? 'http://minio:9000', rootUser: req('MINIO_ROOT_USER'), rootPassword: req('MINIO_ROOT_PASSWORD') },
  platformDb: { host: env.PLATFORM_DB_HOST ?? 'platform-db', password: req('PLATFORM_DB_PASSWORD') },
  port: Number(env.PORT ?? 8080),
}
if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`)

const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }))

async function coolify<T>(method: string, path: string): Promise<T> {
  const res = await fetch(`${config.coolifyUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.coolifyToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`Coolify ${method} ${path.split('?')[0]} -> ${res.status}`)
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

/**
 * BACKUP_CONFIG as it is in Coolify now (the infra sync updates it without a restart), read
 * through the API when the token may see values; else as the container started with it.
 */
const loadConfig: ConfigSource = async () => {
  if (config.resourceUuid) {
    try {
      const envs = await coolify<{ key: string; value?: string; is_preview?: boolean }[]>(
        'GET',
        `/applications/${encodeURIComponent(config.resourceUuid)}/envs`
      )
      const entry = envs.find((e) => e.key === 'BACKUP_CONFIG' && !e.is_preview)
      if (entry && 'value' in entry) return { raw: entry.value || null }
      if (entry)
        return {
          raw: env.BACKUP_CONFIG || null,
          note: 'The Coolify token cannot read values; a changed BACKUP_CONFIG applies after Deploy.',
        }
    } catch (err) {
      log('backup.config_read_failed', { error: String(err).slice(0, 200) })
    }
  }
  return { raw: env.BACKUP_CONFIG || null }
}

const controlPlane: ControlPlaneClient = {
  async createProject(name, postgres) {
    const res = await fetch(`${config.controlPlaneUrl}/projects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, postgres_version: postgres }),
      signal: AbortSignal.timeout(60_000),
    })
    const body = (await res.json().catch(() => ({}))) as { ref?: string; error?: string }
    if (!res.ok || !body.ref) throw new Error(`Creating the new project failed: ${res.status} ${body.error ?? ''}`.trim())
    return body.ref
  },
  async waitActive(ref) {
    const deadline = Date.now() + 15 * 60_000
    while (Date.now() < deadline) {
      const res = await fetch(`${config.controlPlaneUrl}/projects/${ref}`, {
        headers: { Authorization: `Bearer ${config.apiToken}` },
        signal: AbortSignal.timeout(30_000),
      })
      const p = (await res.json().catch(() => ({}))) as { status?: string; last_error?: string }
      if (p.status === 'ACTIVE_HEALTHY') return
      if (p.status === 'FAILED') throw new Error(`The new project failed to start: ${p.last_error ?? ''}`)
      await new Promise((r) => setTimeout(r, 5000))
    }
    throw new Error('The new project did not start within 15 minutes')
  },
}

/** The runner's PITR calls (src/runner/server.ts). Bodies carry wal-g's keys: never logged. */
async function runner<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T | null> {
  const res = await fetch(`${config.runnerUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.runnerToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) {
    const error = (() => {
      try {
        return String((JSON.parse(text) as { error?: string }).error ?? '')
      } catch {
        return ''
      }
    })()
    throw new Error(`Runner ${method} ${path.replace(/^\/stacks\/[^/]+/, '/stacks/…')} -> ${res.status} ${error}`.trim())
  }
  return (text ? JSON.parse(text) : null) as T
}

const stackPath = (id: string) => `/stacks/${encodeURIComponent(id)}`
const pitr: PitrRunner | undefined =
  config.stackBackend === 'runner'
    ? {
        async configure(id, settings) {
          await runner('PUT', `${stackPath(id)}/wal-g`, { settings })
        },
        async backup(id, keepFull) {
          return (await runner<{ backups: BaseBackup[] }>('POST', `${stackPath(id)}/wal-g/backup`, { keep_full: keepFull }, 3 * 60 * 60_000))!.backups
        },
        async backups(id) {
          return (await runner<{ backups: BaseBackup[] }>('GET', `${stackPath(id)}/wal-g/backups`))!.backups
        },
        async startScratch(id, backup, targetTime) {
          return (await runner<{ host: string }>('POST', `${stackPath(id)}/pitr-scratch`, { backup, target_time: targetTime }, 2 * 60 * 60_000))!.host
        },
        async dropScratch(id) {
          await runner('DELETE', `${stackPath(id)}/pitr-scratch`)
        },
      }
    : undefined

const pool = new pg.Pool({ connectionString: config.registryDatabaseUrl, max: 3 })
await migrateRuns(pool)
const runs = createRunStore(pool)
const interrupted = await runs.failInterrupted()
if (interrupted) log('backup.interrupted_runs', { count: interrupted })

const service = new BackupService({
  registry: createPgRegistry(pool, parseSecretsKey(config.secretsKey)),
  runs,
  jobs: {
    exec,
    stageDir: config.stageDir,
    projectsHostDir: config.projectsHostDir,
    domainSuffix: config.domainSuffix,
    minio: config.minio,
    platformDb: config.platformDb,
    log,
  },
  loadConfig,
  controlPlane,
  restartStack: async (uuid, db) => {
    // Coolify answers before the containers stop: wait for Postgres to come back with a new start time.
    const started = async () => {
      const r = await exec('psql', ['-At', '-c', 'select pg_postmaster_start_time()'], {
        env: { PGHOST: db.host, PGUSER: 'supabase_admin', PGPASSWORD: db.password, PGDATABASE: 'postgres', PGCONNECT_TIMEOUT: '5' },
      })
      return r.code === 0 ? r.stdout.trim() : null
    }
    const before = await started()
    if (config.stackBackend === 'runner') {
      const res = await fetch(`${config.runnerUrl}/stacks/${encodeURIComponent(uuid)}/restart`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.runnerToken}` },
        signal: AbortSignal.timeout(10 * 60_000),
      })
      if (!res.ok) throw new Error(`Runner restart of ${uuid} -> ${res.status}`)
    } else {
      await coolify('POST', `/services/${encodeURIComponent(uuid)}/restart`)
    }
    const deadline = Date.now() + 5 * 60_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000))
      const now = await started()
      if (now && now !== before) {
        // GoTrue and storage-api start after the database; give them a moment.
        await new Promise((r) => setTimeout(r, 15_000))
        return
      }
    }
    throw new Error('The new project did not come back after its restart')
  },
  pitr,
  apiToken: config.apiToken,
  log,
})

const server = service.listen(config.port)
const tick = () => service.tick().catch((err: unknown) => log('backup.tick_failed', { error: String(err).slice(0, 300) }))
await tick()
const timer = setInterval(tick, 60_000)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(timer)
    server.close()
    void pool.end().finally(() => process.exit(0))
  })
}
