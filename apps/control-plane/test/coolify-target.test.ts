import { afterEach, describe, expect, it } from 'vitest'

import { resolveCoolifyTarget } from '../src/coolify.ts'

type Call = { method: string; path: string; body?: unknown }

// A Coolify API that knows one platform application and the environments of its project.
function fakeCoolify(environments: string[]) {
  const calls: Call[] = []
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://coolify.test/api/v1', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    if (method === 'GET' && path === '/applications/app-uuid') {
      return Response.json({
        uuid: 'app-uuid',
        environment: { name: 'staging', project: { uuid: 'project-uuid' } },
        destination: { server: { uuid: 'server-uuid' } },
      })
    }
    if (method === 'GET' && path.startsWith('/applications/')) {
      return Response.json({ message: 'Application not found.' }, { status: 404 })
    }
    if (method === 'POST' && /^\/projects\/[^/]+\/environments$/.test(path)) {
      if (environments.includes(body.name)) {
        return Response.json({ message: 'Environment with this name already exists.' }, { status: 409 })
      }
      environments.push(body.name)
      return Response.json({ uuid: 'env-uuid' }, { status: 201 })
    }
    return Response.json({ message: 'unexpected' }, { status: 500 })
  }
  return { calls, environments, fetchImpl }
}

const base = { url: 'https://coolify.test/api/v1', token: 't', environment: 'projects' }
const original = globalThis.fetch
afterEach(() => {
  globalThis.fetch = original
})

describe('resolveCoolifyTarget', () => {
  it("takes the project and server from the platform's own Coolify application", async () => {
    const coolify = fakeCoolify(['staging'])
    globalThis.fetch = coolify.fetchImpl as typeof fetch
    const target = await resolveCoolifyTarget({ ...base, resourceUuid: 'app-uuid' })
    expect(target).toEqual({ ...base, projectUuid: 'project-uuid', serverUuid: 'server-uuid' })
  })

  it('creates the projects environment when it is missing', async () => {
    const coolify = fakeCoolify(['staging'])
    globalThis.fetch = coolify.fetchImpl as typeof fetch
    await resolveCoolifyTarget({ ...base, resourceUuid: 'app-uuid' })
    expect(coolify.environments).toEqual(['staging', 'projects'])
  })

  it('keeps an existing projects environment', async () => {
    const coolify = fakeCoolify(['staging', 'projects'])
    globalThis.fetch = coolify.fetchImpl as typeof fetch
    await expect(resolveCoolifyTarget({ ...base, resourceUuid: 'app-uuid' })).resolves.toMatchObject({
      projectUuid: 'project-uuid',
    })
    expect(coolify.environments).toEqual(['staging', 'projects'])
  })

  it('uses explicit uuids as given, without asking Coolify', async () => {
    const coolify = fakeCoolify([])
    globalThis.fetch = coolify.fetchImpl as typeof fetch
    const explicit = { ...base, projectUuid: 'p', serverUuid: 's', resourceUuid: 'app-uuid' }
    const target = await resolveCoolifyTarget(explicit)
    expect(target).toEqual({ ...base, projectUuid: 'p', serverUuid: 's' })
    expect(coolify.calls.filter((c) => c.method === 'GET')).toEqual([])
  })

  it('fails clearly when its own application is unknown to Coolify', async () => {
    const coolify = fakeCoolify([])
    globalThis.fetch = coolify.fetchImpl as typeof fetch
    await expect(resolveCoolifyTarget({ ...base, resourceUuid: 'gone' })).rejects.toThrow(
      /application gone/
    )
  })
})
