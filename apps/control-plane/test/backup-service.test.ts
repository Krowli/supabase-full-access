import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Exec } from '../src/backup/exec.ts'
import { BackupService } from '../src/backup/service.ts'
import type { Run, RunStore, RunUpdate } from '../src/backup/state.ts'
import { generateProjectSecrets } from '../src/secrets.ts'
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
        createProject: async (name) => {
          const newRef = 'newnewnewnewnewnewne'
          await registry.insert({ ref: newRef, name }, generateProjectSecrets(newRef))
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
      expect(view).toMatchObject({ configured: true, destination: 'main', schedule: '02:30', snapshots: [{ id: 'abcdef0123456789', size_bytes: 42 }] })
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
      expect(calls).toContain('restic restore')
    } finally {
      server.close()
    }
  })
})
