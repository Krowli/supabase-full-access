import type { Coolify, CoolifyService } from '../src/coolify.ts'
import type { Gateway } from '../src/kong.ts'
import type { ObjectStorage } from '../src/minio.ts'
import type { ProjectDirs } from '../src/project-dirs.ts'
import { routedProjects } from '../src/provisioner.ts'
import type { Project, ProjectStatus, ProjectUpdate, Registry } from '../src/registry.ts'
import type { ProjectSecrets } from '../src/secrets.ts'
import type { TenantRegistry, TenantTarget } from '../src/tenants.ts'

export class MemoryRegistry implements Registry {
  projects = new Map<string, Project>()
  secrets = new Map<string, ProjectSecrets>()
  statusHistory: { ref: string; status: ProjectStatus }[] = []

  async insert(p: { ref: string; name: string }, secrets: ProjectSecrets) {
    if (this.projects.has(p.ref)) throw new Error('duplicate key')
    const now = new Date()
    const project: Project = {
      ...p,
      status: 'CREATING',
      coolify_service_uuid: null,
      step: null,
      created_at: now,
      updated_at: now,
      last_error: null,
    }
    this.projects.set(p.ref, project)
    this.secrets.set(p.ref, secrets)
    this.statusHistory.push({ ref: p.ref, status: 'CREATING' })
    return { ...project }
  }
  async get(ref: string) {
    const p = this.projects.get(ref)
    return p ? { ...p } : null
  }
  async list() {
    return [...this.projects.values()].map((p) => ({ ...p }))
  }
  async listByStatus(statuses: ProjectStatus[]) {
    return (await this.list()).filter((p) => statuses.includes(p.status))
  }
  async update(ref: string, update: ProjectUpdate) {
    const p = this.projects.get(ref)
    if (!p) return
    Object.assign(p, update, { updated_at: new Date() })
    if (update.status) this.statusHistory.push({ ref, status: update.status })
  }
  async getSecrets(ref: string) {
    return this.secrets.get(ref) ?? null
  }
  async delete(ref: string) {
    this.projects.delete(ref)
    this.secrets.delete(ref)
  }
  async ping() {}
}

type FakeService = CoolifyService & { name: string; compose: string; envs: Record<string, string> }

/**
 * Coolify in memory. A started service reports `starting:unhealthy` for `pollsUntilHealthy`
 * polls, then `running:healthy`. `failOnce` makes the next call of a method throw.
 */
export class FakeCoolify implements Coolify {
  services = new Map<string, FakeService>()
  calls: string[] = []
  pollsUntilHealthy = 2
  neverHealthy = false
  failOnce = new Map<keyof Coolify, 'before' | 'after'>()
  private polls = new Map<string, number>()
  private seq = 0

  private maybeFail(method: keyof Coolify, when: 'before' | 'after') {
    if (this.failOnce.get(method) === when) {
      this.failOnce.delete(method)
      throw new Error(`simulated failure in ${method}`)
    }
  }

  async findServiceByName(name: string) {
    this.calls.push('findServiceByName')
    return [...this.services.values()].find((s) => s.name === name)?.uuid ?? null
  }
  async createService(name: string, _description: string, compose: string) {
    this.calls.push('createService')
    this.maybeFail('createService', 'before')
    const uuid = `svc${++this.seq}`
    this.services.set(uuid, {
      uuid,
      name,
      compose,
      envs: {},
      status: 'exited',
      connectToDockerNetwork: false,
    })
    this.maybeFail('createService', 'after')
    return uuid
  }
  async getService(uuid: string) {
    this.calls.push('getService')
    const s = this.services.get(uuid)
    if (!s) return null
    if (s.status === 'starting:unhealthy' && !this.neverHealthy) {
      const n = (this.polls.get(uuid) ?? 0) + 1
      this.polls.set(uuid, n)
      if (n > this.pollsUntilHealthy) s.status = 'running:healthy'
    }
    return { uuid, status: s.status, connectToDockerNetwork: s.connectToDockerNetwork }
  }
  async connectToDockerNetwork(uuid: string) {
    this.calls.push('connectToDockerNetwork')
    this.maybeFail('connectToDockerNetwork', 'before')
    this.must(uuid).connectToDockerNetwork = true
  }
  async setEnvs(uuid: string, envs: Record<string, string>) {
    this.calls.push('setEnvs')
    this.maybeFail('setEnvs', 'before')
    Object.assign(this.must(uuid).envs, envs)
  }
  async start(uuid: string) {
    this.calls.push('start')
    this.maybeFail('start', 'before')
    this.must(uuid).status = 'starting:unhealthy'
  }
  async updateCompose(uuid: string, compose: string) {
    this.calls.push('updateCompose')
    this.must(uuid).compose = compose
  }
  async restart(uuid: string) {
    this.calls.push('restart')
    this.must(uuid).status = 'running:healthy'
  }
  async deleteService(uuid: string) {
    this.calls.push('deleteService')
    this.services.delete(uuid)
  }
  private must(uuid: string) {
    const s = this.services.get(uuid)
    if (!s) throw new Error(`no service ${uuid}`)
    return s
  }
}

/** A shared service in memory; `failNext` makes the next call throw once. */
class FailOnce {
  failNext = false
  protected maybeFail(what: string) {
    if (this.failNext) {
      this.failNext = false
      throw new Error(`simulated failure in ${what}`)
    }
  }
}

export class FakeTenants extends FailOnce implements TenantRegistry {
  tenants = new Map<string, TenantTarget>()
  async ensure(t: TenantTarget) {
    this.maybeFail('tenant ensure')
    this.tenants.set(t.ref, t)
  }
  async remove(ref: string) {
    this.maybeFail('tenant remove')
    this.tenants.delete(ref)
  }
}

export class FakeStorage extends FailOnce implements ObjectStorage {
  buckets = new Map<string, string>() // ref -> access key
  async ensureBucket(ref: string, accessKey: string) {
    this.maybeFail('storage ensure')
    this.buckets.set(ref, accessKey)
  }
  async removeBucket(ref: string) {
    this.maybeFail('storage remove')
    this.buckets.delete(ref)
  }
}

export class FakeProjectDirs extends FailOnce implements ProjectDirs {
  dirs = new Set<string>()
  async ensure(ref: string) {
    this.maybeFail('dirs ensure')
    this.dirs.add(ref)
  }
  async remove(ref: string) {
    this.maybeFail('dirs remove')
    this.dirs.delete(ref)
  }
}

/** Records which refs each sync would route, read from the registry like the real one. */
export class FakeGateway extends FailOnce implements Gateway {
  routed: string[] = []
  syncs = 0
  private registry: Registry
  constructor(registry: Registry) {
    super()
    this.registry = registry
  }
  async sync() {
    this.syncs++
    this.maybeFail('gateway sync')
    this.routed = routedProjects(await this.registry.list()).map((p) => p.ref)
  }
}

export function fakeShared(registry: Registry) {
  return {
    storage: new FakeStorage(),
    pooler: new FakeTenants(),
    realtime: new FakeTenants(),
    gateway: new FakeGateway(registry),
    projectDirs: new FakeProjectDirs(),
  }
}
