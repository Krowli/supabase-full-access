import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import type { NextApiRequest, NextApiResponse } from 'next'
import { createMocks, type RequestMethod } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import projectHandler from '../../../../pages/api/platform/projects/[ref]/index'
import retryHandler from '../../../../pages/api/platform/projects/[ref]/retry'
import statusHandler from '../../../../pages/api/platform/projects/[ref]/status'
import projectsHandler from '../../../../pages/api/platform/projects/index'
import { mswServer } from '@/tests/lib/msw'

vi.mock('@/lib/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/constants')>()),
  IS_PLATFORM: false,
}))

/**
 * Creating, retrying and deleting a project (deploy/platform/SPEC.md M6). With the control plane as
 * the registry, Studio's local routes forward to it and drop the cached registry, so the next
 * request sees the change. Without a registry nothing changes.
 */

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>

const call = async (
  handler: Handler,
  {
    method = 'GET',
    query = {},
    body,
  }: { method?: RequestMethod; query?: Record<string, string>; body?: unknown } = {}
) => {
  const { req, res } = createMocks({ method, query, body: body as never })
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse)
  return res
}

const TOKEN = 'cp-token-never-in-a-response'
const REF = 'newprojectnewproject'
const UUID = 'coolifyuuid1'

const cpProject = (overrides: Record<string, unknown> = {}) => ({
  ref: REF,
  name: 'Shop',
  status: 'CREATING',
  step: null,
  coolify_service_uuid: null,
  endpoint: `https://${REF}.example.test`,
  internal: null,
  created_at: '2026-10-12T12:00:00.000Z',
  updated_at: '2026-10-12T12:00:00.000Z',
  last_error: null,
  ...overrides,
})

const SECRETS = {
  db_password: 'db-pass',
  jwt_secret: 'jwt-secret-with-at-least-32-characters',
  anon_key: 'anon',
  service_key: 'service',
}

describe('without a registry', () => {
  beforeEach(() => {
    vi.stubEnv('STUDIO_PROJECT_REGISTRY', undefined)
    vi.stubEnv('STUDIO_PROJECT_REGISTRY_URL', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('still refuses to create a project', async () => {
    const res = await call(projectsHandler, { method: 'POST', body: { name: 'Shop' } })
    expect(res._getStatusCode()).toBe(405)
    expect(res._getJSONData()).toEqual({
      data: null,
      error: { message: 'Method POST Not Allowed' },
    })
  })

  it('still refuses to delete default', async () => {
    const res = await call(projectHandler, { method: 'DELETE', query: { ref: 'default' } })
    expect(res._getStatusCode()).toBe(405)
  })

  it('has nothing to retry', async () => {
    const res = await call(retryHandler, { method: 'POST', query: { ref: 'default' } })
    expect(res._getStatusCode()).toBe(501)
    expect(res._getJSONData().message).toMatch(/STUDIO_PROJECT_REGISTRY_URL/)
  })
})

describe('with a registry file', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'project-lifecycle-'))
    const registry = join(dir, 'registry.json')
    writeFileSync(registry, JSON.stringify({ projects: { default: {} } }))
    vi.stubEnv('STUDIO_PROJECT_REGISTRY', registry)
    vi.stubEnv('STUDIO_PROJECT_REGISTRY_URL', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('says that creating a project needs the control plane', async () => {
    const res = await call(projectsHandler, { method: 'POST', body: { name: 'Shop' } })
    expect(res._getStatusCode()).toBe(501)
    expect(res._getJSONData().message).toMatch(/STUDIO_PROJECT_REGISTRY_URL/)
  })
})

describe('with the control plane as the registry', () => {
  let base: string
  let listed: Record<string, unknown>[]
  let received: { method: string; path: string; authorization: string | null; body?: unknown }[]

  const writes = () => received.filter(({ method }) => method !== 'GET')

  beforeEach(() => {
    // A host per test: the registry is cached per URL.
    base = `http://cp-${Math.random().toString(36).slice(2)}.test`
    listed = []
    received = []
    vi.stubEnv('STUDIO_PROJECT_REGISTRY', undefined)
    vi.stubEnv('STUDIO_PROJECT_REGISTRY_URL', base)
    vi.stubEnv('STUDIO_PROJECT_REGISTRY_TOKEN', TOKEN)
    vi.stubEnv('STUDIO_PROJECT_DOMAIN_SUFFIX', 'example.test')
    mswServer.use(
      http.get(`${base}/projects`, ({ request }) => {
        received.push({
          method: 'GET',
          path: '/projects',
          authorization: request.headers.get('authorization'),
        })
        return HttpResponse.json(listed)
      }),
      http.get(`${base}/projects/:ref/secrets`, () => HttpResponse.json(SECRETS))
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  /** The control plane's create and retry endpoint; `answer` decides the response. */
  const servePost = (answer: (body: Record<string, unknown>) => Response) =>
    mswServer.use(
      http.post(`${base}/projects`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        received.push({
          method: 'POST',
          path: '/projects',
          authorization: request.headers.get('authorization'),
          body,
        })
        return answer(body)
      })
    )

  const serveDelete = (answer: () => Response) =>
    mswServer.use(
      http.delete(`${base}/projects/:ref`, ({ request, params }) => {
        received.push({
          method: 'DELETE',
          path: `/projects/${params.ref}`,
          authorization: request.headers.get('authorization'),
        })
        return answer()
      })
    )

  describe('POST /platform/projects', () => {
    it('creates the project by name alone and answers the create response', async () => {
      servePost(() => HttpResponse.json(cpProject(), { status: 201 }))

      const res = await call(projectsHandler, {
        method: 'POST',
        body: {
          name: 'Shop',
          organization_slug: 'default-org-slug',
          db_pass: 'typed-by-hand',
          cloud_provider: 'AWS',
        },
      })

      expect(res._getStatusCode()).toBe(201)
      expect(writes()).toEqual([
        {
          method: 'POST',
          path: '/projects',
          authorization: `Bearer ${TOKEN}`,
          body: { name: 'Shop' },
        },
      ])
      expect(res._getJSONData()).toMatchObject({
        ref: REF,
        name: 'Shop',
        status: 'COMING_UP',
        organization_id: 1,
        organization_slug: 'default-org-slug',
        endpoint: `https://${REF}.example.test`,
        inserted_at: '2026-10-12T12:00:00.000Z',
      })
    })

    it('shows the new project at once, without waiting for the cached registry to expire', async () => {
      servePost(() => {
        listed = [cpProject()]
        return HttpResponse.json(cpProject(), { status: 201 })
      })

      // The registry is now cached without the new project.
      expect((await call(projectHandler, { query: { ref: REF } }))._getStatusCode()).toBe(404)

      await call(projectsHandler, { method: 'POST', body: { name: 'Shop' } })

      const detail = await call(projectHandler, { query: { ref: REF } })
      expect(detail._getStatusCode()).toBe(200)
      expect(detail._getJSONData()).toMatchObject({ ref: REF, status: 'COMING_UP' })
    })

    it('refuses a missing name without calling the control plane', async () => {
      const res = await call(projectsHandler, { method: 'POST', body: { name: '  ' } })
      expect(res._getStatusCode()).toBe(400)
      expect(res._getJSONData()).toEqual({ message: 'name is required (1-64 chars)' })
      expect(writes()).toEqual([])
    })

    it("passes on the control plane's refusal of the request with its message", async () => {
      servePost(() =>
        HttpResponse.json({ error: 'name is required (1-64 chars)' }, { status: 400 })
      )

      const res = await call(projectsHandler, { method: 'POST', body: { name: 'x'.repeat(65) } })
      expect(res._getStatusCode()).toBe(400)
      expect(res._getJSONData()).toEqual({ message: 'name is required (1-64 chars)' })
    })

    it('answers 502 when the control plane fails, naming the call but not the token', async () => {
      servePost(() => HttpResponse.json({ error: 'Internal error' }, { status: 500 }))

      const res = await call(projectsHandler, { method: 'POST', body: { name: 'Shop' } })
      expect(res._getStatusCode()).toBe(502)
      expect(res._getJSONData()).toEqual({ message: 'control plane POST /projects answered 500' })
    })

    it('answers 502 when the control plane refuses the token', async () => {
      servePost(() => HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }))

      const res = await call(projectsHandler, { method: 'POST', body: { name: 'Shop' } })
      expect(res._getStatusCode()).toBe(502)
      expect(JSON.stringify(res._getJSONData())).not.toContain(TOKEN)
    })

    it('answers 502 when the control plane cannot be reached', async () => {
      servePost(() => HttpResponse.error())

      const res = await call(projectsHandler, { method: 'POST', body: { name: 'Shop' } })
      expect(res._getStatusCode()).toBe(502)
      expect(res._getJSONData().message).toMatch(/^control plane POST \/projects failed/)
    })
  })

  describe('POST /platform/projects/{ref}/retry', () => {
    it('re-runs provisioning of a failed project and shows it coming up at once', async () => {
      listed = [cpProject({ status: 'FAILED', coolify_service_uuid: UUID, last_error: 'boom' })]
      servePost(() => {
        listed = [cpProject({ status: 'CREATING', coolify_service_uuid: UUID })]
        return HttpResponse.json(cpProject({ status: 'FAILED' }), { status: 202 })
      })

      expect((await call(statusHandler, { query: { ref: REF } }))._getJSONData()).toEqual({
        status: 'INIT_FAILED',
      })

      const res = await call(retryHandler, { method: 'POST', query: { ref: REF } })

      expect(res._getStatusCode()).toBe(202)
      expect(res._getJSONData()).toEqual({ ref: REF, status: 'COMING_UP' })
      expect(writes()).toEqual([
        { method: 'POST', path: '/projects', authorization: `Bearer ${TOKEN}`, body: { ref: REF } },
      ])
      expect((await call(statusHandler, { query: { ref: REF } }))._getJSONData()).toEqual({
        status: 'COMING_UP',
      })
    })

    it('answers 404 for a ref the registry does not hold, without calling the control plane', async () => {
      const res = await call(retryHandler, {
        method: 'POST',
        query: { ref: 'unknownunknownunknow' },
      })
      expect(res._getStatusCode()).toBe(404)
      expect(writes()).toEqual([])
    })

    it('has nothing to retry for default', async () => {
      const res = await call(retryHandler, { method: 'POST', query: { ref: 'default' } })
      expect(res._getStatusCode()).toBe(400)
      expect(writes()).toEqual([])
    })

    it('only accepts POST', async () => {
      listed = [cpProject({ status: 'FAILED' })]
      const res = await call(retryHandler, { method: 'GET', query: { ref: REF } })
      expect(res._getStatusCode()).toBe(405)
    })
  })

  describe('DELETE /platform/projects/{ref}', () => {
    it('deletes the project and it is gone at once', async () => {
      listed = [cpProject({ status: 'ACTIVE_HEALTHY', coolify_service_uuid: UUID })]
      serveDelete(() => {
        listed = []
        return HttpResponse.json({ ref: REF, deleted: true })
      })

      const res = await call(projectHandler, { method: 'DELETE', query: { ref: REF } })

      expect(res._getStatusCode()).toBe(200)
      expect(res._getJSONData()).toEqual({ id: 0, ref: REF, name: 'Shop' })
      expect(writes()).toEqual([
        { method: 'DELETE', path: `/projects/${REF}`, authorization: `Bearer ${TOKEN}` },
      ])
      expect((await call(projectHandler, { query: { ref: REF } }))._getStatusCode()).toBe(404)
    })

    it('never deletes default', async () => {
      const res = await call(projectHandler, { method: 'DELETE', query: { ref: 'default' } })
      expect(res._getStatusCode()).toBe(400)
      expect(writes()).toEqual([])
    })

    it("passes on the control plane's conflict while the project is being provisioned", async () => {
      listed = [cpProject({ status: 'COMING_UP', coolify_service_uuid: UUID })]
      serveDelete(() =>
        HttpResponse.json({ error: `Project ${REF} is being provisioned` }, { status: 409 })
      )

      const res = await call(projectHandler, { method: 'DELETE', query: { ref: REF } })
      expect(res._getStatusCode()).toBe(409)
      expect(res._getJSONData()).toEqual({ message: `Project ${REF} is being provisioned` })
    })
  })
})
