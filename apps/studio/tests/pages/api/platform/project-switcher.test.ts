import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import type { NextApiRequest, NextApiResponse } from 'next'
import { createMocks, type RequestMethod } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import orgProjectsHandler from '../../../../pages/api/platform/organizations/[slug]/projects'
import profileHandler from '../../../../pages/api/platform/profile/index'
import projectHandler from '../../../../pages/api/platform/projects/[ref]/index'
import settingsHandler from '../../../../pages/api/platform/projects/[ref]/settings'
import statusHandler from '../../../../pages/api/platform/projects/[ref]/status'
import projectsHandler from '../../../../pages/api/platform/projects/index'
import { DEFAULT_PROJECT } from '@/lib/constants/api'
import { mswServer } from '@/tests/lib/msw'

vi.mock('@/lib/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/constants')>()),
  IS_PLATFORM: false,
}))

/**
 * The routes the project switcher reads (deploy/platform/SPEC.md M2): the project lists, the
 * profile's organization, a project's detail and its status. Without a registry each answers for
 * `default` alone, as before; with one, for every project in it.
 */

const project = (ref: string, name: string) => ({
  name,
  env: {
    POSTGRES_HOST: `supabase-db-${ref}`,
    POSTGRES_PASSWORD: `${ref}-db-password`,
    SUPABASE_URL: `https://${ref}.example.test`,
    SUPABASE_PUBLIC_URL: `https://${ref}.example.test`,
    SUPABASE_ANON_KEY: `${ref}-anon`,
    SUPABASE_SERVICE_KEY: `${ref}-service`,
    AUTH_JWT_SECRET: `${ref}-jwt-secret-with-at-least-32-characters`,
  },
})

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>

const call = async (
  handler: Handler,
  {
    method = 'GET',
    query = {},
    headers = {},
  }: {
    method?: RequestMethod
    query?: Record<string, string>
    headers?: Record<string, string>
  } = {}
) => {
  const { req, res } = createMocks({ method, query, headers })
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse)
  return res
}

const refs = (projects: { ref: string }[]) => projects.map(({ ref }) => ref)

let dir: string

const useRegistry = () => {
  const registry = join(dir, 'registry.json')
  writeFileSync(
    registry,
    JSON.stringify({
      projects: {
        default: {},
        alpha: project('alpha', 'Alpha shop'),
        beta: project('beta', 'Beta blog'),
      },
    })
  )
  vi.stubEnv('STUDIO_PROJECT_REGISTRY', registry)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'project-switcher-'))
  vi.stubEnv('STUDIO_PROJECT_REGISTRY', undefined)
  vi.stubEnv('STUDIO_PROJECT_REGISTRY_URL', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('without a registry', () => {
  it('lists default alone, as a bare array, as before', async () => {
    const res = await call(projectsHandler)
    expect(res._getJSONData()).toEqual([DEFAULT_PROJECT])
  })

  it('pages the same list for a Version 2 caller', async () => {
    const res = await call(projectsHandler, { headers: { version: '2' } })
    expect(res._getJSONData()).toMatchObject({
      pagination: { count: 1, limit: 100, offset: 0 },
      projects: [
        { ref: 'default', name: DEFAULT_PROJECT.name, organization_slug: 'default-org-slug' },
      ],
    })
  })

  it('lists default in the organization', async () => {
    const res = await call(orgProjectsHandler, { query: { slug: 'default-org-slug' } })
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({
      pagination: { count: 1, limit: 100, offset: 0 },
      projects: [
        {
          cloud_provider: 'localhost',
          databases: [
            {
              cloud_provider: 'localhost',
              identifier: 'default',
              region: 'local',
              status: 'ACTIVE_HEALTHY',
              type: 'PRIMARY',
            },
          ],
          inserted_at: DEFAULT_PROJECT.inserted_at,
          integration_source: null,
          is_branch: false,
          name: DEFAULT_PROJECT.name,
          ref: 'default',
          region: 'local',
          status: 'ACTIVE_HEALTHY',
        },
      ],
    })
  })

  it('reports default as running', async () => {
    const res = await call(statusHandler, { query: { ref: 'default' } })
    expect(res._getJSONData()).toEqual({ status: 'ACTIVE_HEALTHY' })
  })

  it('keeps the profile organization on default', async () => {
    const res = await call(profileHandler)
    expect(res._getJSONData().organizations[0].projects).toEqual([
      { ...DEFAULT_PROJECT, connectionString: '' },
    ])
  })
})

describe('with a registry', () => {
  beforeEach(useRegistry)

  it('lists every project as a bare array', async () => {
    const res = await call(projectsHandler)
    expect(refs(res._getJSONData())).toEqual(['default', 'alpha', 'beta'])
  })

  it('pages, sorts and searches for a Version 2 caller', async () => {
    const page = async (query: Record<string, string>) =>
      (await call(projectsHandler, { query, headers: { version: '2' } }))._getJSONData()

    expect(refs((await page({})).projects)).toEqual(['alpha', 'beta', 'default'])
    expect(refs((await page({ sort: 'name_desc' })).projects)).toEqual(['default', 'beta', 'alpha'])
    expect(await page({ limit: '1', offset: '1' })).toMatchObject({
      pagination: { count: 3, limit: 1, offset: 1 },
      projects: [{ ref: 'beta' }],
    })
    expect(refs((await page({ search: 'BLOG' })).projects)).toEqual(['beta'])
    expect(refs((await page({ search: 'alp' })).projects)).toEqual(['alpha'])
  })

  it('lists every project in the organization, each with itself as its primary database', async () => {
    const res = await call(orgProjectsHandler, { query: { slug: 'default-org-slug' } })
    const { pagination, projects } = res._getJSONData()

    expect(pagination).toEqual({ count: 3, limit: 100, offset: 0 })
    expect(
      projects.map(
        ({
          ref,
          name,
          databases,
        }: {
          ref: string
          name: string
          databases: { identifier: string }[]
        }) => [ref, name, databases[0].identifier]
      )
    ).toEqual([
      ['alpha', 'Alpha shop', 'alpha'],
      ['beta', 'Beta blog', 'beta'],
      ['default', DEFAULT_PROJECT.name, 'default'],
    ])
  })

  it('filters the organization list by status', async () => {
    const res = await call(orgProjectsHandler, {
      query: { slug: 'default-org-slug', statuses: 'COMING_UP' },
    })
    expect(res._getJSONData().projects).toEqual([])
  })

  it('answers 404 for another organization', async () => {
    const res = await call(orgProjectsHandler, { query: { slug: 'someone-else' } })
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({
      error: { message: 'Organization someone-else not found' },
    })
  })

  it('reports each project status, and 404 for one it does not hold', async () => {
    expect((await call(statusHandler, { query: { ref: 'beta' } }))._getJSONData()).toEqual({
      status: 'ACTIVE_HEALTHY',
    })
    expect((await call(statusHandler, { query: { ref: 'nope' } }))._getStatusCode()).toBe(404)
  })

  it('puts every project in the profile organization', async () => {
    const res = await call(profileHandler)
    const projects = res._getJSONData().organizations[0].projects
    expect(projects.map(({ ref, name }: { ref: string; name: string }) => [ref, name])).toEqual([
      ['default', DEFAULT_PROJECT.name],
      ['alpha', 'Alpha shop'],
      ['beta', 'Beta blog'],
    ])
    expect(projects[1]).toMatchObject({ connectionString: '', organization_id: 1 })
  })

  it('reports the project detail with its registry status', async () => {
    const res = await call(projectHandler, { query: { ref: 'alpha' } })
    expect(res._getJSONData()).toMatchObject({
      ref: 'alpha',
      name: 'Alpha shop',
      status: 'ACTIVE_HEALTHY',
      restUrl: 'https://alpha.example.test/rest/v1/',
    })
  })

  it.each(['POST', 'DELETE'] as const)('refuses %s on the new routes', async (method) => {
    expect((await call(statusHandler, { method, query: { ref: 'alpha' } }))._getStatusCode()).toBe(
      405
    )
    expect(
      (
        await call(orgProjectsHandler, { method, query: { slug: 'default-org-slug' } })
      )._getStatusCode()
    ).toBe(405)
  })
})

describe('with the control plane as the registry', () => {
  const REF = 'buildingbuildingbuil'

  beforeEach(() => {
    const base = `http://cp-${Math.random().toString(36).slice(2)}.test`
    vi.stubEnv('STUDIO_PROJECT_REGISTRY_URL', base)
    vi.stubEnv('STUDIO_PROJECT_REGISTRY_TOKEN', 'token')
    vi.stubEnv('STUDIO_PROJECT_DOMAIN_SUFFIX', 'example.test')
    mswServer.use(
      http.get(`${base}/projects`, () =>
        HttpResponse.json([
          {
            ref: REF,
            name: 'Still building',
            status: 'CREATING',
            coolify_service_uuid: null,
            created_at: '2026-10-12T10:00:00.000Z',
          },
        ])
      )
    )
  })

  it('shows a project that is still being created as coming up', async () => {
    expect((await call(statusHandler, { query: { ref: REF } }))._getJSONData()).toEqual({
      status: 'COMING_UP',
    })
    expect((await call(projectHandler, { query: { ref: REF } }))._getJSONData()).toMatchObject({
      ref: REF,
      name: 'Still building',
      status: 'COMING_UP',
      inserted_at: '2026-10-12T10:00:00.000Z',
    })
    const { projects } = (
      await call(orgProjectsHandler, {
        query: { slug: 'default-org-slug', statuses: 'COMING_UP' },
      })
    )._getJSONData()
    expect(projects.map(({ ref }: { ref: string }) => ref)).toEqual([REF])
  })

  it('refuses its database until its stack exists', async () => {
    const res = await call(settingsHandler, { query: { ref: REF } })
    expect(res._getStatusCode()).toBe(500)
    expect(res._getJSONData()).toEqual({
      error: { message: `Project ${REF} is not ready (COMING_UP): it has no POSTGRES_HOST yet` },
    })
  })
})
