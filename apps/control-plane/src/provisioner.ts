import type { Coolify } from './coolify.ts'
import type { Project, Registry } from './registry.ts'
import { generateProjectSecrets, generateRef, type ProjectSecrets } from './secrets.ts'

export type ProvisionerDeps = {
  registry: Registry
  coolify: Coolify
  /** The compose text for one project, with {{placeholders}} already rendered. */
  renderCompose: (ref: string) => string
  /** The Coolify env vars the compose reads as ${NAME}. */
  serviceEnvs: (secrets: ProjectSecrets) => Record<string, string>
  healthTimeoutMs: number
  pollIntervalMs: number
  log?: (event: string, fields: Record<string, unknown>) => void
  sleep?: (ms: number) => Promise<void>
}

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Creates and deletes project stacks in Coolify. Every step checks what already exists, so a
 * run that stopped anywhere (error, crash, restart) is finished by running provision() again:
 *
 *   CREATING:   find or create the Coolify service (by name = ref, so a crash between Coolify's
 *               response and saving the uuid cannot make a duplicate), connect it to the
 *               `coolify` network, set the env vars.
 *   COMING_UP:  start it unless it is already up, then poll Coolify until running:healthy.
 *   ACTIVE_HEALTHY, or FAILED with last_error.
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
    try {
      const project = await registry.get(ref)
      if (!project) throw new NotFoundError(`Project ${ref} not found`)
      if (project.status === 'ACTIVE_HEALTHY') return
      await registry.update(ref, { status: 'CREATING', last_error: null })

      const uuid = await this.ensureService(project)
      await coolify.connectToDockerNetwork(uuid)
      const secrets = await registry.getSecrets(ref)
      if (!secrets) throw new Error(`Secrets for ${ref} are missing`)
      await coolify.setEnvs(uuid, this.deps.serviceEnvs(secrets))
      this.log('project.configured', { ref, uuid })

      await registry.update(ref, { status: 'COMING_UP' })
      const current = await coolify.getService(uuid)
      if (!current) throw new Error(`Coolify service ${uuid} disappeared`)
      if (/^(running|starting|restarting)/.test(current.status)) {
        this.log('project.start_skipped', { ref, uuid, status: current.status })
      } else {
        await coolify.start(uuid)
        this.log('project.start_queued', { ref, uuid })
      }
      await this.waitHealthy(uuid)

      await registry.update(ref, { status: 'ACTIVE_HEALTHY', last_error: null })
      this.log('project.healthy', { ref, uuid })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log('project.failed', { ref, error: message })
      await registry.update(ref, { status: 'FAILED', last_error: message }).catch(() => {})
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
   * Deletes the Coolify service (with volumes, networks and configuration) and the registry
   * rows. Coolify removes the containers asynchronously after it accepts the request.
   */
  async delete(ref: string): Promise<void> {
    const { registry, coolify } = this.deps
    if (this.running.has(ref)) throw new ConflictError(`Project ${ref} is being provisioned`)
    const project = await registry.get(ref)
    if (!project) throw new NotFoundError(`Project ${ref} not found`)

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
    await registry.delete(ref)
    this.log('project.deleted', { ref })
  }
}
