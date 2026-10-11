import { beforeEach, describe, expect, it } from 'vitest'

import { ConflictError, NotFoundError, Provisioner } from '../src/provisioner.ts'
import { generateProjectSecrets } from '../src/secrets.ts'
import { fakeShared, FakeCoolify, MemoryRegistry } from './fakes.ts'

let registry: MemoryRegistry
let coolify: FakeCoolify
let shared: ReturnType<typeof fakeShared>
let provisioner: Provisioner

beforeEach(() => {
  registry = new MemoryRegistry()
  coolify = new FakeCoolify()
  shared = fakeShared(registry)
  provisioner = new Provisioner({
    registry,
    coolify,
    ...shared,
    renderCompose: (ref) => `compose for ${ref}`,
    serviceEnvs: (s) => ({ PROJECT_DB_PASSWORD: s.db_password, PROJECT_JWT_SECRET: s.jwt_secret }),
    healthTimeoutMs: 60_000,
    pollIntervalMs: 0,
    sleep: async () => {},
  })
})

const statuses = (ref: string) =>
  registry.statusHistory.filter((h) => h.ref === ref).map((h) => h.status)

async function createAndWait(name = 'Demo') {
  const { project, done } = await provisioner.create(name)
  await done
  return (await registry.get(project.ref))!
}

describe('create', () => {
  it('walks CREATING -> COMING_UP -> ACTIVE_HEALTHY with one configured, started service', async () => {
    const p = await createAndWait()
    expect(p.status).toBe('ACTIVE_HEALTHY')
    expect(p.last_error).toBeNull()
    expect(statuses(p.ref)).toEqual(['CREATING', 'CREATING', 'COMING_UP', 'ACTIVE_HEALTHY'])

    expect(coolify.services.size).toBe(1)
    const svc = coolify.services.get(p.coolify_service_uuid!)!
    expect(svc.name).toBe(p.ref)
    expect(svc.compose).toBe(`compose for ${p.ref}`)
    expect(svc.connectToDockerNetwork).toBe(true)
    const secrets = (await registry.getSecrets(p.ref))!
    expect(svc.envs).toEqual({
      PROJECT_DB_PASSWORD: secrets.db_password,
      PROJECT_JWT_SECRET: secrets.jwt_secret,
    })

    const order = coolify.calls.filter((c) => !['getService', 'findServiceByName'].includes(c))
    expect(order).toEqual(['createService', 'connectToDockerNetwork', 'setEnvs', 'start'])
  })

  it('registers the project in MinIO, Supavisor, Realtime and Kong', async () => {
    const p = await createAndWait()
    const secrets = (await registry.getSecrets(p.ref))!
    expect(p.step).toBeNull()
    expect(shared.storage.buckets.get(p.ref)).toBe(secrets.s3_access_key)
    const target = {
      ref: p.ref,
      dbHost: `supabase-db-${p.coolify_service_uuid}`,
      dbPassword: secrets.db_password,
      jwtSecret: secrets.jwt_secret,
    }
    expect(shared.pooler.tenants.get(p.ref)).toEqual(target)
    expect(shared.realtime.tenants.get(p.ref)).toEqual(target)
    expect(shared.gateway.routed).toEqual([p.ref])
  })

  it('ends FAILED with last_error when the stack never becomes healthy', async () => {
    coolify.neverHealthy = true
    provisioner = new Provisioner({
      registry,
      coolify,
      ...shared,
      renderCompose: () => 'c',
      serviceEnvs: () => ({}),
      healthTimeoutMs: 20,
      pollIntervalMs: 5,
    })
    const p = await createAndWait()
    expect(p.status).toBe('FAILED')
    expect(p.last_error).toMatch(/Not healthy .*starting:unhealthy/)
  })

  it('shares one run between concurrent provision calls for the same ref', async () => {
    const { project, done } = await provisioner.create('Demo')
    const again = provisioner.provision(project.ref)
    expect(provisioner.isRunning(project.ref)).toBe(true)
    await Promise.all([done, again])
    expect(coolify.calls.filter((c) => c === 'createService')).toHaveLength(1)
    expect(coolify.calls.filter((c) => c === 'start')).toHaveLength(1)
  })
})

describe('resuming after a failure', () => {
  it.each([
    ['storage', 'storage'],
    ['pooler', 'pooler'],
    ['realtime', 'realtime'],
    ['gateway', 'gateway'],
  ] as const)(
    'a failure in the %s service leaves FAILED at step %s, and a re-run finishes',
    async (service, step) => {
      shared[service].failNext = true
      const failed = await createAndWait()
      expect(failed).toMatchObject({ status: 'FAILED', step })
      expect(failed.last_error).toContain('simulated failure')

      await provisioner.provision(failed.ref)
      const p = (await registry.get(failed.ref))!
      expect(p).toMatchObject({ status: 'ACTIVE_HEALTHY', step: null, last_error: null })
      expect(coolify.services.size).toBe(1)
      expect(shared.realtime.tenants.has(p.ref)).toBe(true)
      expect(shared.gateway.routed).toEqual([p.ref])
    }
  )

  it.each([
    ['connectToDockerNetwork', 'before'],
    ['setEnvs', 'before'],
    ['start', 'before'],
  ] as const)(
    'a failure in %s leaves FAILED, and a re-run finishes with the same service',
    async (method, when) => {
      coolify.failOnce.set(method, when)
      const failed = await createAndWait()
      expect(failed.status).toBe('FAILED')
      expect(failed.last_error).toContain(`simulated failure in ${method}`)
      expect(failed.coolify_service_uuid).not.toBeNull()

      await provisioner.provision(failed.ref)
      const p = (await registry.get(failed.ref))!
      expect(p.status).toBe('ACTIVE_HEALTHY')
      expect(p.last_error).toBeNull()
      expect(p.coolify_service_uuid).toBe(failed.coolify_service_uuid)
      expect(coolify.services.size).toBe(1)
      expect(coolify.calls.filter((c) => c === 'createService')).toHaveLength(1)
    }
  )

  it('a crash after Coolify created the service but before the uuid was saved makes no duplicate', async () => {
    coolify.failOnce.set('createService', 'after')
    const failed = await createAndWait()
    expect(failed.status).toBe('FAILED')
    expect(failed.coolify_service_uuid).toBeNull()
    expect(coolify.services.size).toBe(1)

    await provisioner.provision(failed.ref)
    const p = (await registry.get(failed.ref))!
    expect(p.status).toBe('ACTIVE_HEALTHY')
    expect(coolify.services.size).toBe(1)
    expect(p.coolify_service_uuid).toBe([...coolify.services.keys()][0])
  })

  it('recreates the service when the saved uuid no longer exists in Coolify', async () => {
    const p = await createAndWait()
    coolify.services.clear()
    await registry.update(p.ref, { status: 'FAILED' })
    await provisioner.provision(p.ref)
    const again = (await registry.get(p.ref))!
    expect(again.status).toBe('ACTIVE_HEALTHY')
    expect(again.coolify_service_uuid).not.toBe(p.coolify_service_uuid)
    expect(coolify.services.size).toBe(1)
  })

  it('does not start a service that is already running, and leaves ACTIVE_HEALTHY alone', async () => {
    const p = await createAndWait()
    await registry.update(p.ref, { status: 'COMING_UP' })
    coolify.calls = []
    await provisioner.provision(p.ref)
    expect((await registry.get(p.ref))!.status).toBe('ACTIVE_HEALTHY')
    expect(coolify.calls).not.toContain('start')
    expect(coolify.calls).not.toContain('createService')

    coolify.calls = []
    await provisioner.provision(p.ref)
    expect(coolify.calls).toEqual([])
  })

  it('resumeInterrupted picks up CREATING and COMING_UP, not FAILED', async () => {
    for (const [ref, status] of [
      ['aaaaaaaaaaaaaaaaaaaa', 'CREATING'],
      ['bbbbbbbbbbbbbbbbbbbb', 'COMING_UP'],
      ['cccccccccccccccccccc', 'FAILED'],
    ] as const) {
      await registry.insert({ ref, name: ref }, generateProjectSecrets(ref))
      await registry.update(ref, { status })
    }
    const refs = await provisioner.resumeInterrupted()
    expect(refs.sort()).toEqual(['aaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbb'])
    await Promise.all(refs.map((r) => provisioner.provision(r)))
    expect((await registry.get('aaaaaaaaaaaaaaaaaaaa'))!.status).toBe('ACTIVE_HEALTHY')
    expect((await registry.get('cccccccccccccccccccc'))!.status).toBe('FAILED')
  })
})

describe('delete', () => {
  it('deletes the Coolify service, the shared-service registrations and the registry rows', async () => {
    const p = await createAndWait()
    const other = await createAndWait('Other')
    await provisioner.delete(p.ref)
    expect(coolify.services.size).toBe(1)
    expect(await registry.get(p.ref)).toBeNull()
    expect(await registry.getSecrets(p.ref)).toBeNull()
    expect(shared.gateway.routed).toEqual([other.ref])
    expect([...shared.pooler.tenants.keys()]).toEqual([other.ref])
    expect([...shared.realtime.tenants.keys()]).toEqual([other.ref])
    expect([...shared.storage.buckets.keys()]).toEqual([other.ref])
  })

  it('a failure part-way leaves DELETING with the step, and deleting again finishes', async () => {
    const p = await createAndWait()
    shared.realtime.failNext = true
    await expect(provisioner.delete(p.ref)).rejects.toThrow(/simulated failure/)
    const stuck = (await registry.get(p.ref))!
    expect(stuck).toMatchObject({ status: 'DELETING', step: 'realtime' })
    expect(shared.gateway.routed).toEqual([])

    await provisioner.provision(p.ref)
    expect((await registry.get(p.ref))!.status).toBe('DELETING')

    await provisioner.delete(p.ref)
    expect(await registry.get(p.ref)).toBeNull()
    expect(coolify.services.size).toBe(0)
    expect(shared.storage.buckets.size).toBe(0)
  })

  it('finds the service by name when its uuid was never saved', async () => {
    coolify.failOnce.set('createService', 'after')
    const failed = await createAndWait()
    expect(failed.coolify_service_uuid).toBeNull()
    await provisioner.delete(failed.ref)
    expect(coolify.services.size).toBe(0)
    expect(await registry.get(failed.ref)).toBeNull()
  })

  it('works when nothing exists in Coolify, and 404s an unknown ref', async () => {
    coolify.failOnce.set('createService', 'before')
    const failed = await createAndWait()
    await provisioner.delete(failed.ref)
    expect(coolify.calls).not.toContain('deleteService')
    await expect(provisioner.delete(failed.ref)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('refuses while the project is being provisioned', async () => {
    const { project, done } = await provisioner.create('Demo')
    await expect(provisioner.delete(project.ref)).rejects.toBeInstanceOf(ConflictError)
    await done
  })
})
