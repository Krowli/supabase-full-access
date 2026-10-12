import type { Coolify } from './coolify.ts'
import type { Gateway } from './kong.ts'
import type { ObjectStorage } from './minio.ts'
import type { ProjectDirs } from './project-dirs.ts'
import type { Project, Registry } from './registry.ts'
import { generateProjectSecrets, generateRef, type ProjectSecrets } from './secrets.ts'
import type { TenantRegistry } from './tenants.ts'

export type ProvisionerDeps = {
  registry: Registry
  coolify: Coolify
  /** The compose text for one project, with {{placeholders}} already rendered. */
  renderCompose: (ref: string) => string
  /** The Coolify env vars the compose reads as ${NAME}. */
  serviceEnvs: (secrets: ProjectSecrets) => Record<string, string>
  /** The shared services each project is registered in (SPEC.md §5). */
  storage: ObjectStorage
  pooler: TenantRegistry
  realtime: TenantRegistry
  gateway: Gateway
  /** The host directories Studio writes the project's GoTrue and storage settings into. */
  projectDirs: ProjectDirs
  healthTimeoutMs: number
  pollIntervalMs: number
  log?: (event: string, fields: Record<string, unknown>) => void
  sleep?: (ms: number) => Promise<void>
}

/** The projects Kong routes and the public gateway issues certificates for. */
export function routedProjects(projects: Project[]): Project[] {
  return projects.filter((p) => p.coolify_service_uuid && p.status !== 'DELETING')
}

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Creates and deletes project stacks in Coolify and registers them in the shared services.
 * Every step checks what already exists, so a run that stopped anywhere (error, crash,
 * restart) is finished by running provision() again. `step` in the registry names the step
 * that ran last; with FAILED it is the one that failed.
 *
 *   CREATING:   config_dirs (the host directories the stack binds, before anything can start
 *               it), coolify_service (find or create by name = ref, so a crash between Coolify's
 *               response and saving the uuid cannot make a duplicate), network (join `coolify`),
 *               storage (MinIO bucket <ref> and its scoped key), envs.
 *   COMING_UP:  start (unless already up), health (poll Coolify until running:healthy),
 *               pooler (Supavisor tenant), realtime (Realtime tenant), gateway (Kong config).
 *   ACTIVE_HEALTHY, or FAILED with step and last_error.
 *
 * Delete runs the same in reverse under DELETING, the config directories last, and stays DELETING with last_error until a
 * repeated delete gets through.
 *
 * One instance per registry: runs are serialised per ref in this process only.
 */
export class Provisioner {
  private deps: ProvisionerDeps
  private running = new Map<string, Promise<void>>()
  private sleep: (ms: number) => Promise<void>
  private log: (event: string, fields: Record<string, unknown>) => void

  constructor(deps: ProvisionerDeps) {
    this.deps = deps
    this.sleep = deps.sleep ?? defaultSleep
    this.log = deps.log ?? (() => {})
  }

  isRunning(ref: string): boolean {
    return this.running.has(ref)
  }

  /** Registers a new project and starts provisioning it in the background. */
  async create(name: string): Promise<{ project: Project; done: Promise<void> }> {
    const ref = generateRef()
    const project = await this.deps.registry.insert({ ref, name }, generateProjectSecrets(ref))
    this.log('project.created', { ref })
    return { project, done: this.provision(ref) }
  }

  /** Runs (or joins the run already in progress) until ACTIVE_HEALTHY or FAILED. Never rejects. */
  provision(ref: string): Promise<void> {
    const inFlight = this.running.get(ref)
    if (inFlight) return inFlight
    const run = this.runSteps(ref).finally(() => this.running.delete(ref))
    this.running.set(ref, run)
    return run
  }

  /** Picks up projects a previous process left mid-way. FAILED ones wait for an explicit retry. */
  async resumeInterrupted(): Promise<string[]> {
    const stuck = await this.deps.registry.listByStatus(['CREATING', 'COMING_UP'])
    for (const p of stuck) void this.provision(p.ref)
    return stuck.map((p) => p.ref)
  }

  private async runSteps(ref: string): Promise<void> {
    const { registry, coolify } = this.deps
    let current = 'load'
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      current = name
      await registry.update(ref, { step: name })
      return fn()
    }
    try {
      const project = await registry.get(ref)
      if (!project) throw new NotFoundError(`Project ${ref} not found`)
      if (project.status === 'ACTIVE_HEALTHY') return
      if (project.status === 'DELETING') throw new ConflictError(`Project ${ref} is being deleted`)
      await registry.update(ref, { status: 'CREATING', last_error: null })
      const secrets = await registry.getSecrets(ref)
      if (!secrets) throw new Error(`Secrets for ${ref} are missing`)

      await step('config_dirs', () => this.deps.projectDirs.ensure(ref))
      const uuid = await step('coolify_service', () => this.ensureService(project))
      await step('network', () => coolify.connectToDockerNetwork(uuid))
      await step('storage', () =>
        this.deps.storage.ensureBucket(ref, secrets.s3_access_key, secrets.s3_secret_key)
      )
      await step('envs', () => coolify.setEnvs(uuid, this.deps.serviceEnvs(secrets)))
      this.log('project.configured', { ref, uuid })

      await registry.update(ref, { status: 'COMING_UP' })
      await step('start', async () => {
        const service = await coolify.getService(uuid)
        if (!service) throw new Error(`Coolify service ${uuid} disappeared`)
        if (/^(running|starting|restarting)/.test(service.status)) {
          this.log('project.start_skipped', { ref, uuid, status: service.status })
        } else {
          await coolify.start(uuid)
          this.log('project.start_queued', { ref, uuid })
        }
      })
      await step('health', () => this.waitHealthy(uuid))

      const target = {
        ref,
        dbHost: `supabase-db-${uuid}`,
        dbPassword: secrets.db_password,
        jwtSecret: secrets.jwt_secret,
      }
      await step('pooler', () => this.deps.pooler.ensure(target))
      await step('realtime', () => this.deps.realtime.ensure(target))
      await step('gateway', () => this.deps.gateway.sync())

      await registry.update(ref, { status: 'ACTIVE_HEALTHY', step: null, last_error: null })
      this.log('project.healthy', { ref, uuid })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log('project.failed', { ref, step: current, error: message })
      if (err instanceof ConflictError || err instanceof NotFoundError) return
      await registry
        .update(ref, { status: 'FAILED', step: current, last_error: message })
        .catch(() => {})
    }
  }

  private async ensureService(project: Project): Promise<string> {
    const { registry, coolify } = this.deps
    if (project.coolify_service_uuid) {
      if (await coolify.getService(project.coolify_service_uuid))
        return project.coolify_service_uuid
      this.log('project.service_missing', { ref: project.ref, uuid: project.coolify_service_uuid })
    }
    let uuid = await coolify.findServiceByName(project.ref)
    if (uuid) {
      this.log('project.service_found', { ref: project.ref, uuid })
    } else {
      uuid = await coolify.createService(
        project.ref,
        project.name,
        this.deps.renderCompose(project.ref)
      )
      this.log('project.service_created', { ref: project.ref, uuid })
    }
    await registry.update(project.ref, { coolify_service_uuid: uuid })
    return uuid
  }

  private async waitHealthy(uuid: string): Promise<void> {
    const deadline = Date.now() + this.deps.healthTimeoutMs
    let status = 'unknown'
    while (Date.now() < deadline) {
      const service = await this.deps.coolify.getService(uuid)
      if (!service) throw new Error(`Coolify service ${uuid} disappeared`)
      status = service.status
      if (status === 'running:healthy') return
      await this.sleep(this.deps.pollIntervalMs)
    }
    throw new Error(
      `Not healthy after ${Math.round(this.deps.healthTimeoutMs / 1000)}s (last Coolify status: ${status})`
    )
  }

  /**
   * Puts the current project template into an existing project's Coolify service and restarts
   * it (the services restart with the new compose; data and settings stay). For template changes
   * that existing projects need, e.g. a new command for one of the containers.
   */
  async updateStack(ref: string): Promise<void> {
    if (this.running.has(ref)) throw new ConflictError(`Project ${ref} is being provisioned`)
    const { registry, coolify } = this.deps
    const project = await registry.get(ref)
    if (!project) throw new NotFoundError(`Project ${ref} not found`)
    const uuid = project.coolify_service_uuid
    if (project.status !== 'ACTIVE_HEALTHY' || !uuid)
      throw new ConflictError(`Project ${ref} is ${project.status}, not ACTIVE_HEALTHY`)
    if (!(await coolify.getService(uuid))) throw new Error(`Coolify service ${uuid} disappeared`)
    await coolify.updateCompose(uuid, this.deps.renderCompose(ref))
    await coolify.restart(uuid)
    this.log('project.stack_updated', { ref, uuid })
  }

  /**
   * Removes the project from Kong, Realtime and Supavisor, deletes the Coolify service (with
   * volumes, networks and configuration), the MinIO bucket and key, the settings directories
   * Studio wrote, then the registry rows.
   * Coolify removes the containers asynchronously after it accepts the request. A failure
   * leaves DELETING with step and last_error; calling delete again continues.
   */
  async delete(ref: string): Promise<void> {
    if (this.running.has(ref)) throw new ConflictError(`Project ${ref} is being provisioned`)
    const run = this.runDelete(ref).finally(() => this.running.delete(ref))
    this.running.set(
      ref,
      run.catch(() => {})
    )
    return run
  }

  private async runDelete(ref: string): Promise<void> {
    const { registry, coolify } = this.deps
    const project = await registry.get(ref)
    if (!project) throw new NotFoundError(`Project ${ref} not found`)
    const secrets = await registry.getSecrets(ref)
    let current = 'gateway'
    const step = async (name: string, fn: () => Promise<void>) => {
      current = name
      await registry.update(ref, { step: name })
      await fn()
    }
    try {
      // DELETING takes the project out of the Kong config first, so traffic stops.
      await registry.update(ref, { status: 'DELETING', last_error: null })
      await step('gateway', () => this.deps.gateway.sync())
      await step('realtime', () => this.deps.realtime.remove(ref))
      await step('pooler', () => this.deps.pooler.remove(ref))
      await step('coolify_service', async () => {
        const uuids = new Set<string>()
        if (project.coolify_service_uuid) uuids.add(project.coolify_service_uuid)
        const byName = await coolify.findServiceByName(ref)
        if (byName) uuids.add(byName)
        for (const uuid of uuids) {
          if (await coolify.getService(uuid)) {
            await coolify.deleteService(uuid)
            this.log('project.service_deleted', { ref, uuid })
          }
        }
      })
      if (secrets) {
        await step('storage', () => this.deps.storage.removeBucket(ref, secrets.s3_access_key))
      }
      await step('config_dirs', () => this.deps.projectDirs.remove(ref))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log('project.delete_failed', { ref, step: current, error: message })
      await registry.update(ref, { step: current, last_error: message }).catch(() => {})
      throw err
    }
    await registry.delete(ref)
    this.log('project.deleted', { ref })
  }
}
