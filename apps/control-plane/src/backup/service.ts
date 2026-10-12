// The backup service (deploy/platform/SPEC.md §19): a daily backup of every project and of the
// platform database, "Back up now" and "Restore into a new project" for Studio, and /health for
// Coolify. One job runs at a time; the rest wait in a queue.

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { Project, Registry } from '../registry.ts'
import { parseBackupConfig, PLATFORM_REPOSITORY, resolvePolicy, type BackupConfig, type Policy } from './config.ts'
import { backupPlatform, backupProject, listSnapshots, removeRepository, restoreIntoProject, type JobDeps, type ProjectDb, type Snapshot } from './jobs.ts'
import { healthProblems, isDue } from './schedule.ts'
import type { Run, RunKind, RunStore } from './state.ts'

export type ConfigSource = () => Promise<{ raw: string | null; note?: string }>

export type ControlPlaneClient = {
  createProject(name: string): Promise<string>
  waitActive(ref: string): Promise<void>
}

export type ServiceDeps = {
  registry: Registry
  runs: RunStore
  jobs: JobDeps
  loadConfig: ConfigSource
  controlPlane: ControlPlaneClient
  /** Restarts a project's Coolify service; resolves once its database is back. */
  restartStack: (uuid: string, db: ProjectDb) => Promise<void>
  apiToken: string
  log: (event: string, fields: Record<string, unknown>) => void
  now?: () => Date
}

type Job = { run: Run; work: () => Promise<Partial<Run>> }

const REF = /^[a-z]{20}$/

export class BackupService {
  private deps: ServiceDeps
  private queue: Job[] = []
  private busy = false
  private config: BackupConfig | null = null
  private configError: string | null = 'Not loaded yet'
  private configNote: string | undefined
  private snapshots = new Map<string, { at: number; list: Snapshot[] }>()
  private pruning = false

  constructor(deps: ServiceDeps) {
    this.deps = deps
  }

  private now() {
    return this.deps.now?.() ?? new Date()
  }

  async reloadConfig(): Promise<BackupConfig | null> {
    try {
      const { raw, note } = await this.deps.loadConfig()
      this.configNote = note
      if (!raw) {
        this.config = null
        this.configError = 'No BACKUP_CONFIG: backups are off. Set it in the infra repository (platform/backups.yaml).'
        return null
      }
      this.config = parseBackupConfig(raw)
      this.configError = null
    } catch (err) {
      // Keep the last good configuration; report the problem.
      this.configError = String((err as Error).message ?? err).slice(0, 300)
    }
    return this.config
  }

  private policy(project: { ref: string; name: string }): Policy | null {
    return this.config ? resolvePolicy(this.config, project) : null
  }

  private async projectDb(project: Project): Promise<ProjectDb> {
    const secrets = await this.deps.registry.getSecrets(project.ref)
    if (!secrets || !project.coolify_service_uuid) throw new Error(`Project ${project.ref} has no stack yet`)
    return { host: `supabase-db-${project.coolify_service_uuid}`, password: secrets.db_password }
  }

  /** Queues a backup; the run is recorded at once so Studio sees it waiting. */
  async enqueueBackup(ref: string, kind: Exclude<RunKind, 'restore'>): Promise<Run> {
    const isPlatform = ref === PLATFORM_REPOSITORY
    const project = isPlatform ? null : await this.deps.registry.get(ref)
    if (!isPlatform && !project) throw new HttpError(404, 'Project not found')
    const policy = this.policy(project ?? { ref, name: ref })
    if (!policy) throw new HttpError(409, this.configError ?? 'Backups are not configured')
    const run = await this.deps.runs.insert({ ref, kind, destination: policy.destinationName })
    this.push({
      run,
      work: async () => {
        const result = isPlatform
          ? await backupPlatform(this.deps.jobs, policy, ref)
          : await backupProject(this.deps.jobs, project!, await this.projectDb(project!), policy)
        this.snapshots.delete(ref)
        return { snapshot_id: result.snapshotId, size_bytes: result.sizeBytes }
      },
    })
    return run
  }

  async enqueueRestore(ref: string, snapshotId: string, name: string): Promise<Run> {
    const source = await this.deps.registry.get(ref)
    if (!source) throw new HttpError(404, 'Project not found')
    const policy = this.policy(source)
    if (!policy) throw new HttpError(409, this.configError ?? 'Backups are not configured')
    const snapshots = await this.snapshotList(ref, policy, true)
    if (!snapshots.some((s) => s.id === snapshotId)) throw new HttpError(404, 'Backup not found')
    const run = await this.deps.runs.insert({ ref, kind: 'restore', destination: policy.destinationName })
    this.push({
      run,
      work: async () => {
        const targetRef = await this.deps.controlPlane.createProject(name)
        await this.deps.runs.update(run.id, { target_ref: targetRef })
        await this.deps.controlPlane.waitActive(targetRef)
        const target = await this.deps.registry.get(targetRef)
        if (!target?.coolify_service_uuid) throw new Error(`New project ${targetRef} has no stack`)
        const db = await this.projectDb(target)
        const warnings = await restoreIntoProject(
          this.deps.jobs,
          policy,
          ref,
          snapshotId,
          { ref: targetRef, db, restart: () => this.deps.restartStack(target.coolify_service_uuid!, db) },
          String(run.id)
        )
        return { target_ref: targetRef, warnings: warnings.length ? warnings.join('\n').slice(0, 4000) : null }
      },
    })
    return run
  }

  private push(job: Job) {
    this.queue.push(job)
    void this.drain()
  }

  private async drain() {
    if (this.busy) return
    this.busy = true
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        const { run } = job
        await this.deps.runs.update(run.id, { status: 'running', started_at: this.now() })
        this.deps.log('backup.run_started', { id: run.id, ref: run.ref, kind: run.kind })
        try {
          const result = await job.work()
          await this.deps.runs.update(run.id, { ...result, status: 'succeeded', finished_at: this.now() })
          this.deps.log('backup.run_succeeded', { id: run.id, ref: run.ref, kind: run.kind })
        } catch (err) {
          const error = String((err as Error).message ?? err).slice(0, 1000)
          await this.deps.runs.update(run.id, { status: 'failed', error, finished_at: this.now() })
          this.deps.log('backup.run_failed', { id: run.id, ref: run.ref, kind: run.kind, error })
        }
      }
    } finally {
      this.busy = false
    }
  }

  /** Every minute: reload the configuration, queue what is due. */
  async tick(): Promise<void> {
    const config = await this.reloadConfig()
    if (!config) return
    const now = this.now()
    const projects = (await this.deps.registry.list()).filter((p) => p.status === 'ACTIVE_HEALTHY')
    const items = [{ ref: PLATFORM_REPOSITORY, name: PLATFORM_REPOSITORY }, ...projects]
    for (const p of items) {
      const policy = resolvePolicy(config, p)
      if (!policy.enabled) continue
      if (this.queue.some((j) => j.run.ref === p.ref)) continue
      const { lastScheduledStart } = await this.deps.runs.summary(p.ref)
      if (isDue(now, policy.schedule, lastScheduledStart)) await this.enqueueBackup(p.ref, 'scheduled')
    }
    await this.pruneDeleted(config, now)
  }

  /**
   * The backups of a deleted project stay deleted_project_retention_days (counted from when this
   * service first sees the project gone), then its repository is removed. A destination no longer
   * in the configuration is left alone until it is back; a failed removal is retried next tick.
   */
  private async pruneDeleted(config: BackupConfig, now: Date): Promise<void> {
    if (this.pruning) return
    this.pruning = true
    try {
      const { runs, registry } = this.deps
      const live = new Set((await registry.list()).map((p) => p.ref))
      for (const { ref, destination } of await runs.backedUp())
        if (ref !== PLATFORM_REPOSITORY && !live.has(ref)) await runs.noticeDeleted(ref, destination, now)

      const cutoff = now.getTime() - config.deleted_project_retention_days * 24 * 60 * 60 * 1000
      for (const d of await runs.deletedPending()) {
        if (d.deleted_at.getTime() > cutoff) continue
        const target = config.destinations[d.destination]
        if (!target) continue
        try {
          await removeRepository(this.deps.jobs, target, d.ref)
          await runs.markRemoved(d.ref, now)
          this.snapshots.delete(d.ref)
          this.deps.log('backup.deleted_project_removed', { ref: d.ref, destination: d.destination })
        } catch (err) {
          this.deps.log('backup.deleted_project_remove_failed', {
            ref: d.ref,
            error: String((err as Error).message ?? err).slice(0, 300),
          })
        }
      }
    } finally {
      this.pruning = false
    }
  }

  async health(): Promise<string[]> {
    if (this.configError) return [this.configError]
    const config = this.config!
    const projects = (await this.deps.registry.list()).filter((p) => p.status === 'ACTIVE_HEALTHY')
    const items = []
    for (const p of [{ ref: PLATFORM_REPOSITORY, name: 'platform', created_at: new Date(0) }, ...projects]) {
      const policy = resolvePolicy(config, p)
      if (!policy.enabled) continue
      const s = await this.deps.runs.summary(p.ref)
      items.push({
        id: p.ref === PLATFORM_REPOSITORY ? 'platform' : p.name,
        schedule: policy.schedule,
        createdAt: p.created_at,
        runs: {
          lastStarted: s.last?.started_at ?? null,
          lastStatus: s.last?.status === 'failed' ? ('failed' as const) : s.last ? ('succeeded' as const) : null,
          lastError: s.last?.error,
          lastSuccess: s.lastSuccess,
        },
      })
    }
    return healthProblems(this.now(), items)
  }

  private async snapshotList(ref: string, policy: Policy, fresh = false): Promise<Snapshot[]> {
    const cached = this.snapshots.get(ref)
    if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.list
    const list = await listSnapshots(this.deps.jobs, policy, ref)
    this.snapshots.set(ref, { at: Date.now(), list })
    return list
  }

  /** What Studio's Backups page shows. No keys, no passwords. */
  async projectView(ref: string) {
    const project = await this.deps.registry.get(ref)
    if (!project) throw new HttpError(404, 'Project not found')
    const policy = this.policy(project)
    const runs = await this.deps.runs.list(ref, 20)
    const base = {
      configured: Boolean(policy),
      config_error: this.configError,
      config_note: this.configNote ?? null,
      deleted_project_retention_days: this.config?.deleted_project_retention_days ?? null,
      runs,
    }
    if (!policy) return { ...base, enabled: false, destination: null, schedule: null, keep: null, snapshots: [], snapshots_error: null }
    let snapshots: Snapshot[] = []
    let snapshotsError: string | null = null
    try {
      snapshots = await this.snapshotList(ref, policy)
    } catch (err) {
      snapshotsError = String((err as Error).message ?? err).slice(0, 300)
    }
    return {
      ...base,
      enabled: policy.enabled,
      destination: policy.destinationName,
      schedule: policy.schedule,
      keep: policy.keep,
      snapshots,
      snapshots_error: snapshotsError,
    }
  }

  listen(port: number): Server {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500
        if (status === 500) this.deps.log('backup.http_error', { error: String(err).slice(0, 300) })
        send(res, status, { message: status === 500 ? 'Internal error' : (err as Error).message })
      })
    })
    return server.listen(port, () => this.deps.log('backup.listening', { port }))
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://local').pathname.replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'
    if (method === 'GET' && path === '/health') {
      const problems = await this.health()
      return send(res, problems.length ? 503 : 200, { ok: problems.length === 0, problems })
    }
    if (!authorized(req, this.deps.apiToken)) throw new HttpError(401, 'Unauthorized')

    const m = /^\/projects\/([^/]+)(?:\/(backups|restore))?$/.exec(path)
    if (!m || !REF.test(m[1])) throw new HttpError(404, 'Not found')
    const [, ref, action] = m
    if (!action && method === 'GET') return send(res, 200, await this.projectView(ref))
    if (action === 'backups' && method === 'POST') return send(res, 202, await this.enqueueBackup(ref, 'manual'))
    if (action === 'restore' && method === 'POST') {
      const body = await readJson(req)
      const snapshotId = typeof body.snapshot_id === 'string' ? body.snapshot_id : ''
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!/^[0-9a-f]{8,64}$/.test(snapshotId)) throw new HttpError(400, 'snapshot_id is required')
      if (!name || name.length > 64) throw new HttpError(400, 'name is required (1-64 chars)')
      return send(res, 202, await this.enqueueRestore(ref, snapshotId, name))
    }
    throw new HttpError(405, 'Method not allowed')
  }
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16 * 1024) throw new HttpError(413, 'Body too large')
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch {
    throw new HttpError(400, 'Body must be a JSON object')
  }
}
