import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Exec } from '../src/backup/exec.ts'
import type { PitrRunner } from '../src/backup/pitr.ts'
import type { BaseBackup } from '../src/runner/walg.ts'
import { BackupService } from '../src/backup/service.ts'
import type { Run, RunStore, RunUpdate } from '../src/backup/state.ts'
import { generateProjectSecrets } from '../src/secrets.ts'
import type { PostgresVersion } from '../src/template.ts'
import { MemoryRegistry } from './fakes.ts'

const CONFIG = `
destinations:
  main: { type: s3, endpoint: "http://127.0.0.1:1", bucket: backups, access_key_id: a, secret_access_key: s }
default: { destination: main }
encryption_key: 0123456789abcdef0123456789abcdef
`

class MemoryRuns implements RunStore {
  rows: Run[] = []
  async insert(r: { ref: string; kind: Run['kind']; destination?: string | null }) {
    const run: Run = {
      id: this.rows.length + 1,
      ref: r.ref,
      kind: r.kind,
      status: 'queued',
      destination: r.destination ?? null,
      snapshot_id: null,
      size_bytes: null,
      target_ref: null,
      error: null,
      warnings: null,
      started_at: null,
      finished_at: null,
      created_at: new Date(),
    }
    this.rows.push(run)
    return { ...run }
  }
  async update(id: number, u: RunUpdate) {
    Object.assign(this.rows[id - 1], u)
  }
  async get(id: number) {
    return this.rows[id - 1] ?? null
  }
  async list(ref: string, limit: number) {
    return this.rows.filter((r) => r.ref === ref).reverse().slice(0, limit)
  }
  async failInterrupted() {
    return 0
  }
  deleted = new Map<string, { destination: string; deleted_at: Date; removed_at: Date | null }>()
  async backedUp() {
    const last = new Map<string, string>()
    for (const r of this.rows)
      if (r.kind !== 'restore' && r.status === 'succeeded' && r.destination) last.set(r.ref, r.destination)
    return [...last].map(([ref, destination]) => ({ ref, destination }))
  }
  async noticeDeleted(ref: string, destination: string, at: Date) {
    if (!this.deleted.has(ref)) this.deleted.set(ref, { destination, deleted_at: at, removed_at: null })
  }
  async deletedPending() {
    return [...this.deleted]
      .filter(([, d]) => !d.removed_at)
      .map(([ref, d]) => ({ ref, destination: d.destination, deleted_at: d.deleted_at }))
  }
  async markRemoved(ref: string, at: Date) {
    this.deleted.get(ref)!.removed_at = at
  }
  async summary(ref: string) {
    const mine = this.rows.filter((r) => r.ref === ref)
    const scheduled = mine.filter((r) => r.kind === 'scheduled').map((r) => r.started_at ?? r.created_at)
    const done = mine.filter((r) => r.kind !== 'restore' && (r.status === 'succeeded' || r.status === 'failed'))
    const ok = mine.filter((r) => r.kind !== 'restore' && r.status === 'succeeded').map((r) => r.finished_at!)
    return {
      lastScheduledStart: scheduled.length ? scheduled[scheduled.length - 1] : null,
      last: done.at(-1) ?? null,
      lastSuccess: ok.length ? ok[ok.length - 1] : null,
    }
  }
}

/** Every tool succeeds; restic answers like restic does. `fail` makes one tool fail. */
function fakeExec(calls: string[], fail?: string, onRestore?: (target: string) => Promise<void>): Exec {
  return async (cmd, args) => {
    const sub = cmd === 'restic' ? args[args.indexOf('s3.bucket-lookup=path') + 1] : args[0]
    calls.push(`${cmd} ${sub}`)
    if (fail && cmd === fail) return { code: 1, stdout: '', stderr: `${cmd}: it broke\n` }
    if (cmd === 'restic' && sub === 'backup')
      return { code: 0, stdout: '{"message_type":"summary","snapshot_id":"abcdef0123456789","total_bytes_processed":42}\n', stderr: '' }
    if (cmd === 'restic' && sub === 'snapshots')
      return { code: 0, stdout: '[{"id":"abcdef0123456789","time":"2026-10-12T02:30:00Z","summary":{"total_bytes_processed":42}}]', stderr: '' }
    if (cmd === 'restic' && sub === 'restore') await onRestore?.(args[args.indexOf('--target') + 1])
    if (cmd === 'psql') return { code: 0, stdout: 'a'.repeat(64) + '\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

const settle = () => new Promise((r) => setTimeout(r, 50))

describe('BackupService', () => {
  let stage: string
  let registry: MemoryRegistry
  let runs: MemoryRuns
  let calls: string[]
  const ref = 'abcdefghijabcdefghij'

  const service = (opts: { config?: string | null; fail?: string; now?: string } = {}) =>
    new BackupService({
      registry,
      runs,
      jobs: {
        exec: fakeExec(calls, opts.fail, async (target) => {
          const db = join(target, stage, ref, 'db')
          await mkdir(db, { recursive: true })
          await writeFile(join(db, 'roles.sql'), 'CREATE ROLE appuser;\n')
          await writeFile(join(db, 'pgsodium_root.key'), 'b'.repeat(64))
        }),
        stageDir: stage,
        projectsHostDir: join(stage, 'projects'),
        domainSuffix: 'supa.example.com',
        minio: { url: 'http://minio:9000', rootUser: 'u', rootPassword: 'p' },
        platformDb: { host: 'platform-db', password: 'p' },
        log: () => {},
      },
      loadConfig: async () => ({ raw: opts.config === undefined ? CONFIG : opts.config }),
      controlPlane: {
        createProject: async (name, postgres) => {
          const newRef = 'newnewnewnewnewnewne'
          const postgres_version = postgres as PostgresVersion
          await registry.insert({ ref: newRef, name, postgres_version }, generateProjectSecrets(newRef))
          await registry.update(newRef, { status: 'ACTIVE_HEALTHY', coolify_service_uuid: 'uuid2' })
          return newRef
        },
        waitActive: async () => {},
      },
      restartStack: async () => {},
      apiToken: 'token',
      log: () => {},
      now: () => new Date(opts.now ?? '2026-10-12T03:00:00Z'),
    })

  beforeEach(async () => {
    stage = await mkdtemp(join(tmpdir(), 'backup-test-'))
    registry = new MemoryRegistry()
    runs = new MemoryRuns()
    calls = []
    await registry.insert({ ref, name: 'demo' }, generateProjectSecrets(ref))
    await registry.update(ref, { status: 'ACTIVE_HEALTHY', coolify_service_uuid: 'uuid1' })
    registry.projects.get(ref)!.created_at = new Date('2026-01-01T00:00:00Z')
  })
  afterEach(async () => {
    await rm(stage, { recursive: true, force: true })
  })

  it('backs up every project and the platform once its schedule has passed, then not again that day', async () => {
    const s = service()
    await s.tick()
    await settle()
    expect(runs.rows.map((r) => [r.ref, r.kind, r.status, r.snapshot_id])).toEqual([
      ['_platform', 'scheduled', 'succeeded', 'abcdef0123456789'],
      [ref, 'scheduled', 'succeeded', 'abcdef0123456789'],
    ])
    expect(calls).toContain('pg_dumpall --roles-only')
    expect(calls).toContain('mc mirror')
    expect(calls).toContain('restic forget')
    await s.tick()
    await settle()
    expect(runs.rows).toHaveLength(2)
    expect(await s.health()).toEqual([])
  })

  it('waits for the schedule', async () => {
    await service({ now: '2026-10-12T02:00:00Z' }).tick()
    expect(runs.rows).toHaveLength(0)
  })

  it('records a failure and reports it as unhealthy', async () => {
    const s = service({ fail: 'pg_dump' })
    await s.tick()
    await settle()
    const failed = runs.rows.find((r) => r.ref === ref)!
    expect(failed).toMatchObject({ status: 'failed' })
    expect(failed.error).toContain('it broke')
    expect((await s.health()).join('\n')).toContain('demo: last backup failed')
  })

  it('is unhealthy without a configuration, and says why', async () => {
    const s = service({ config: null })
    await s.tick()
    expect(runs.rows).toHaveLength(0)
    expect((await s.health())[0]).toContain('No BACKUP_CONFIG')
    expect(await s.projectView(ref)).toMatchObject({ configured: false, snapshots: [] })
  })

  it('removes the backups of a deleted project once its retention has passed, once', async () => {
    await service().tick()
    await settle()
    registry.projects.delete(ref)

    await service({ now: '2026-10-13T03:00:00Z' }).tick()
    expect(runs.deleted.get(ref)).toMatchObject({ destination: 'main', removed_at: null })
    expect(calls.filter((c) => c === 'mc rm')).toHaveLength(0)

    await service({ now: '2026-11-11T03:00:00Z' }).tick() // 29 days after it was noticed
    expect(calls.filter((c) => c === 'mc rm')).toHaveLength(0)

    calls.length = 0
    const s = service({ now: '2026-11-12T03:01:00Z' }) // 30 days
    await s.tick()
    expect(calls).toContain('mc rm')
    expect(runs.deleted.get(ref)!.removed_at).toEqual(new Date('2026-11-12T03:01:00Z'))
    await s.tick()
    expect(calls.filter((c) => c === 'mc rm')).toHaveLength(1)
    expect(runs.deleted.has('_platform')).toBe(false)
  })

  it('removes at once with retention 0, and waits when the destination is gone from the config', async () => {
    await service().tick()
    await settle()
    registry.projects.delete(ref)
    const other = CONFIG.replaceAll('main', 'other')
    await service({ config: `${other}deleted_project_retention_days: 0\n`, now: '2026-10-13T03:00:00Z' }).tick()
    expect(calls).not.toContain('mc rm')
    expect(runs.deleted.get(ref)!.removed_at).toBeNull()

    await service({ config: `${CONFIG}deleted_project_retention_days: 0\n`, now: '2026-10-13T03:01:00Z' }).tick()
    expect(calls).toContain('mc rm')
  })

  it('a failed removal is retried on the next tick', async () => {
    await service().tick()
    await settle()
    registry.projects.delete(ref)
    await service({ config: `${CONFIG}deleted_project_retention_days: 0\n`, fail: 'mc', now: '2026-10-13T03:00:00Z' }).tick()
    expect(runs.deleted.get(ref)!.removed_at).toBeNull()
    await service({ config: `${CONFIG}deleted_project_retention_days: 0\n`, now: '2026-10-13T03:01:00Z' }).tick()
    expect(runs.deleted.get(ref)!.removed_at).not.toBeNull()
  })

  it('serves Studio: view, back up now, restore into a new project', async () => {
    const s = service()
    await s.reloadConfig()
    const server = s.listen(0)
    const port = (server.address() as AddressInfo).port
    const call = (method: string, path: string, body?: unknown, token = 'token') =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    try {
      expect((await call('GET', `/projects/${ref}`, undefined, 'wrong')).status).toBe(401)
      expect((await call('GET', '/projects/unknownunknownunknow')).status).toBe(404)

      const view = await (await call('GET', `/projects/${ref}`)).json()
      expect(view).toMatchObject({ configured: true, destination: 'main', schedule: '02:30', deleted_project_retention_days: 30, snapshots: [{ id: 'abcdef0123456789', size_bytes: 42 }] })
      expect(JSON.stringify(view)).not.toContain('0123456789abcdef0123456789abcdef')

      expect((await call('POST', `/projects/${ref}/backups`)).status).toBe(202)
      expect((await call('POST', `/projects/${ref}/restore`, { snapshot_id: 'ffffffff', name: 'x' })).status).toBe(404)
      expect((await call('POST', `/projects/${ref}/restore`, { snapshot_id: 'abcdef0123456789' })).status).toBe(400)
      const restore = await call('POST', `/projects/${ref}/restore`, { snapshot_id: 'abcdef0123456789', name: 'demo restored' })
      expect(restore.status).toBe(202)
      await settle()
      await settle()
      const run = runs.rows.find((r) => r.kind === 'restore')!
      expect(run.error).toBeNull()
      expect(run).toMatchObject({ status: 'succeeded', target_ref: 'newnewnewnewnewnewne' })
      expect(registry.projects.get('newnewnewnewnewnewne')!.postgres_version).toBe('15')
      expect(calls).toContain('restic restore')
    } finally {
      server.close()
    }
  })
})

describe('BackupService: point-in-time recovery', () => {
  const PITR_CONFIG = `
destinations:
  main: { type: s3, endpoint: "http://127.0.0.1:1", bucket: backups, prefix: restic, access_key_id: a, secret_access_key: s }
default: { destination: main, schedule: "02:30" }
pitr: { prefix: pitr }
projects:
  demo: { pitr: true }
encryption_key: 0123456789abcdef0123456789abcdef
`
  const ref = 'abcdefghijabcdefghij'
  let stage: string
  let registry: MemoryRegistry
  let runs: MemoryRuns
  let clock: Date
  let calls: string[]
  /** What pg_stat_archiver says: archive_mode, last archived WAL and time, failures. */
  let archive: { mode: string; wal: string; at: Date | null; failed: number; failedAt: Date | null }
  let backups: BaseBackup[]
  let runnerCalls: string[]
  let backupFails: boolean
  let dumpedFrom: string[]

  const base = (name: string, finish: string): BaseBackup => ({
    name,
    start_time: finish,
    finish_time: finish,
    compressed_size: 1,
    uncompressed_size: 2,
  })
  const epoch = (d: Date | null) => (d ? String(d.getTime() / 1000) : '')

  const exec: Exec = async (cmd, args, options) => {
    const sql = args.at(-1) ?? ''
    calls.push(`${cmd} ${args[0]}`)
    if (cmd === 'pg_dump' || cmd === 'pg_dumpall') dumpedFrom.push(options?.env?.PGHOST ?? '')
    if (cmd === 'psql' && sql.includes('pg_stat_archiver'))
      return { code: 0, stdout: [archive.mode, archive.wal, epoch(archive.at), archive.failed, epoch(archive.failedAt)].join('|') + '\n', stderr: '' }
    if (cmd === 'psql' && sql.includes('pg_switch_wal')) {
      archive.wal = '000000010000000000000007'
      return { code: 0, stdout: '000000010000000000000007\n', stderr: '' }
    }
    if (cmd === 'psql' && sql.includes('pg_read_file')) return { code: 0, stdout: 'c'.repeat(64) + '\n', stderr: '' }
    if (cmd === 'psql' && sql.includes('pg_roles')) return { code: 0, stdout: 'postgres\n', stderr: '' }
    if (cmd === 'pg_dumpall') await writeFile(args[args.indexOf('-f') + 1], 'CREATE ROLE appuser;\n')
    if (cmd === 'pg_restore' && args[0] === '-l') return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }

  const runner: PitrRunner = {
    async configure(id, settings) {
      runnerCalls.push(`configure ${id} ${settings.prefix}`)
    },
    async backup(id, keepFull) {
      runnerCalls.push(`backup ${id} ${keepFull}`)
      if (backupFails) throw new Error('Runner POST /stacks/…/wal-g/backup -> 500 upload failed')
      backups = [...backups, base(`base_00000001000000000000000${backups.length + 2}`, clock.toISOString())]
      return backups
    },
    async backups() {
      return backups
    },
    async startScratch(id, backup, at) {
      runnerCalls.push(`scratch ${id} ${backup} ${at}`)
      return `pitr-${id}`
    },
    async dropScratch(id) {
      runnerCalls.push(`drop ${id}`)
    },
  }

  const service = () =>
    new BackupService({
      registry,
      runs,
      jobs: {
        exec,
        stageDir: stage,
        projectsHostDir: join(stage, 'projects'),
        domainSuffix: 'supa.example.com',
        minio: { url: 'http://minio:9000', rootUser: 'u', rootPassword: 'p' },
        platformDb: { host: 'platform-db', password: 'p' },
        log: () => {},
      },
      loadConfig: async () => ({ raw: PITR_CONFIG }),
      controlPlane: {
        createProject: async (name, postgres) => {
          const newRef = 'newnewnewnewnewnewne'
          const postgres_version = postgres as PostgresVersion
          await registry.insert({ ref: newRef, name, postgres_version }, generateProjectSecrets(newRef))
          await registry.update(newRef, { status: 'ACTIVE_HEALTHY', coolify_service_uuid: 'uuid2' })
          return newRef
        },
        waitActive: async () => {},
      },
      restartStack: async () => {},
      pitr: runner,
      apiToken: 'token',
      log: () => {},
      now: () => clock,
      sleep: async () => {},
    })

  beforeEach(async () => {
    stage = await mkdtemp(join(tmpdir(), 'pitr-test-'))
    registry = new MemoryRegistry()
    runs = new MemoryRuns()
    calls = []
    runnerCalls = []
    dumpedFrom = []
    backupFails = false
    backups = []
    // Before today's restic schedule, so only PITR acts in these tests.
    clock = new Date('2026-11-06T01:00:00Z')
    archive = { mode: 'off', wal: '', at: null, failed: 0, failedAt: null }
    // On Postgres 17: the copy at a moment must be a 17 project too.
    await registry.insert({ ref, name: 'demo', postgres_version: '17' }, generateProjectSecrets(ref))
    await registry.update(ref, { status: 'ACTIVE_HEALTHY', coolify_service_uuid: 'uuid1' })
    registry.projects.get(ref)!.created_at = new Date('2026-01-01T00:00:00Z')
  })
  afterEach(async () => {
    await rm(stage, { recursive: true, force: true })
  })

  it('writes the settings once and waits, without alarm, for the restart that turns archiving on', async () => {
    const s = service()
    await s.tick()
    await s.tick()
    expect(runnerCalls).toEqual([`configure uuid1 s3://backups/pitr/${ref}`])
    // (restic's own "never backed up" lines are about the nightly backups, not PITR)
    expect((await s.health()).filter((p) => /recovery|WAL|base backup/.test(p))).toEqual([])
    expect((await s.projectView(ref)).pitr).toMatchObject({ archive_mode: 'off', waiting_for_restart: true, earliest: null })
  })

  it('takes the first base backup as soon as archiving is on, then one a day after the schedule', async () => {
    archive = { mode: 'on', wal: '000000010000000000000003', at: clock, failed: 0, failedAt: null }
    const s = service()
    await s.tick()
    await settle()
    expect(runnerCalls.filter((c) => c.startsWith('backup'))).toEqual(['backup uuid1 7'])
    clock = new Date('2026-11-06T02:00:00Z')
    await s.tick()
    await settle()
    expect(runnerCalls.filter((c) => c.startsWith('backup'))).toHaveLength(1)
    clock = new Date('2026-11-06T02:31:00Z')
    await s.tick()
    await settle()
    expect(runnerCalls.filter((c) => c.startsWith('backup'))).toHaveLength(2)
    expect(await s.health()).toEqual([])
    expect((await s.projectView(ref)).pitr).toMatchObject({
      archive_mode: 'on',
      failing: false,
      earliest: '2026-11-06T01:00:00.000Z',
      latest: '2026-11-06T02:31:00.000Z',
    })
  })

  it('reports archiving that fails for more than ten minutes, and a failed base backup', async () => {
    const s = service()
    archive = { mode: 'on', wal: '000000010000000000000003', at: new Date('2026-11-06T00:40:00Z'), failed: 4, failedAt: clock }
    backupFails = true
    await s.tick()
    await settle()
    const problems = (await s.health()).join('\n')
    expect(problems).toContain('demo: WAL archiving fails since 2026-11-06T00:40:00.000Z')
    expect(problems).toContain('demo: last base backup failed: Runner POST /stacks/…/wal-g/backup -> 500 upload failed')
    expect((await s.projectView(ref)).pitr).toMatchObject({ failing: true, latest: null })
  })

  it('restores the database as it was at a moment into a new project, from a paused copy', async () => {
    archive = { mode: 'on', wal: '000000010000000000000003', at: clock, failed: 0, failedAt: null }
    backups = [base('base_000000010000000000000002', '2026-11-05T02:30:09Z'), base('base_000000010000000000000004', '2026-11-06T00:30:00Z')]
    const s = service()
    await s.tick()
    await settle()
    await expect(s.enqueuePitrRestore(ref, new Date('2026-11-06T02:00:00Z'), 'copy')).rejects.toThrow(/in the past/)
    await expect(s.enqueuePitrRestore(ref, new Date('2026-11-05T01:00:00Z'), 'copy')).rejects.toThrow(/earliest moment is 2026-11-05T02:30:09Z/)

    const run = await s.enqueuePitrRestore(ref, new Date('2026-11-06T00:20:00Z'), 'copy')
    for (let i = 0; i < 100 && !['succeeded', 'failed'].includes(runs.rows.find((r) => r.id === run.id)!.status); i++) await settle()
    const done = runs.rows.find((r) => r.id === run.id)!
    expect(done).toMatchObject({ kind: 'restore', status: 'succeeded', target_ref: 'newnewnewnewnewnewne', snapshot_id: 'base_000000010000000000000002' })
    expect(done.warnings?.split('\n')[0]).toBe('The database as it was at 2026-11-06T00:20:00.000Z; Storage files and settings as they are now.')
    expect(calls).toContain('psql -At') // the commit and the WAL switch before the copy
    expect(runnerCalls.slice(-2)).toEqual(['scratch uuid1 base_000000010000000000000002 2026-11-06T00:20:00.000Z', 'drop uuid1'])
    expect(dumpedFrom).toEqual(['pitr-uuid1', 'pitr-uuid1'])
    expect(registry.projects.get('newnewnewnewnewnewne')!.postgres_version).toBe('17')
  })

  it('takes a restore at a moment over the API', async () => {
    archive = { mode: 'on', wal: '000000010000000000000003', at: clock, failed: 0, failedAt: null }
    backups = [base('base_000000010000000000000002', '2026-11-05T02:30:09Z')]
    const s = service()
    await s.tick()
    await settle()
    const server = s.listen(0)
    await new Promise((r) => server.once('listening', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/projects/${ref}/restore`
    const auth = { Authorization: 'Bearer token', 'Content-Type': 'application/json' }
    try {
      const bad = await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify({ target_time: 'yesterday', name: 'x' }) })
      expect(bad.status).toBe(400)
      const ok = await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify({ target_time: '2026-11-06T00:20:00Z', name: 'copy' }) })
      expect(ok.status).toBe(202)
      const { id, kind } = await ok.json()
      expect(kind).toBe('restore')
      // The restore goes on in the background: let it finish before the stage directory goes.
      for (let i = 0; i < 100 && runs.rows.find((r) => r.id === id)?.status !== 'succeeded'; i++) await settle()
      expect(runs.rows.find((r) => r.id === id)?.status).toBe('succeeded')
    } finally {
      server.close()
    }
  })
})
