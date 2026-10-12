import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import { createMocks } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AUTH_JWT_SECRET } from './constants'
import {
  adminJwtSecret,
  invalidateProjectRegistry,
  isMultiProject,
  listProjects,
  projectEnv,
  projectJwtSecret,
  projectPostgres,
  runWithProject,
  withProjectContext,
} from './project-context'
import { mswServer } from '@/tests/lib/msw'

const PROJ1 = {
  POSTGRES_HOST: 'supabase-db-uuid1',
  POSTGRES_PASSWORD: 'proj1-db-password',
  SUPABASE_URL: 'http://proj1.kong.test:8000',
  SUPABASE_PUBLIC_URL: 'https://proj1.example.test',
  SUPABASE_ANON_KEY: 'proj1-anon',
  SUPABASE_SERVICE_KEY: 'proj1-service',
  AUTH_JWT_SECRET: 'proj1-jwt-secret-with-at-least-32-characters',
}

let dir: string

const writeRegistry = (registry: unknown) => {
  // A fresh file per call: the registry is cached per path, so a new path is a fresh read.
  const path = join(dir, `registry-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(path, typeof registry === 'string' ? registry : JSON.stringify(registry))
  vi.stubEnv('STUDIO_PROJECT_REGISTRY', path)
  return path
}

const twoProjects = () =>
  writeRegistry({
    projectsDir: '/data/projects',
    projects: { default: {}, proj1: { name: 'Project one', env: PROJ1 } },
  })

const callWrapped = async (query: Record<string, string>, body?: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST', query, body })
  const handler = vi.fn(async () => {
    res.status(200).json({ host: projectEnv('POSTGRES_HOST') ?? null })
  })
  await withProjectContext(req, res, handler)
  return { res, handler }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'project-context-'))
  vi.stubEnv('STUDIO_PROJECT_REGISTRY', undefined)
  vi.stubEnv('STUDIO_PROJECT_REGISTRY_URL', undefined)
  vi.stubEnv('STUDIO_DEFAULT_PROJECT', undefined)
  vi.stubEnv('PLATFORM_ADMIN_JWT_SECRET', undefined)
  vi.stubEnv('AUTH_JWT_SECRET', 'default-jwt-secret-with-at-least-32-characters')
  vi.stubEnv('POSTGRES_HOST', 'db')
  vi.stubEnv('POSTGRES_PASSWORD', 'default-db-password')
  vi.stubEnv('SUPABASE_URL', 'http://kong:8000')
  vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'default-publishable')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('without a registry', () => {
  it('is not multi-project', () => {
    expect(isMultiProject()).toBe(false)
  })

  it('reads every project value straight from the container environment', () => {
    expect(projectEnv('SUPABASE_URL')).toBe('http://kong:8000')
    expect(projectEnv('POSTGRES_HOST')).toBe('db')
    expect(projectEnv('SUPABASE_SECRET_KEY')).toBeUndefined()
  })

  it('applies the same Postgres defaults as constants.ts', async () => {
    vi.stubEnv('POSTGRES_HOST', undefined)
    vi.stubEnv('POSTGRES_PASSWORD', undefined)
    expect(projectPostgres()).toEqual({
      host: 'db',
      port: 5432,
      database: 'postgres',
      password: 'postgres',
      userReadWrite: 'supabase_admin',
      userReadOnly: 'supabase_read_only_user',
    })
  })

  it('runs the handler as-is, whatever the ref', async () => {
    const { res, handler } = await callWrapped({ ref: 'no-such-project' })

    expect(handler).toHaveBeenCalledOnce()
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({ host: 'db' })
  })

  it('signs admin tokens and reports the project secret with AUTH_JWT_SECRET', () => {
    expect(adminJwtSecret()).toBe('default-jwt-secret-with-at-least-32-characters')
    expect(projectJwtSecret()).toBe('default-jwt-secret-with-at-least-32-characters')
  })

  it('falls back to the CLI default secret when AUTH_JWT_SECRET is unset', () => {
    vi.stubEnv('AUTH_JWT_SECRET', undefined)
    expect(adminJwtSecret()).toBe(DEFAULT_AUTH_JWT_SECRET)
    expect(projectJwtSecret()).toBe(DEFAULT_AUTH_JWT_SECRET)
  })
})

describe('with a registry of two projects', () => {
  beforeEach(() => {
    twoProjects()
  })

  it('is multi-project', () => {
    expect(isMultiProject()).toBe(true)
  })

  it('resolves each ref to its own backends', async () => {
    expect((await callWrapped({ ref: 'proj1' })).res._getJSONData()).toEqual({
      host: 'supabase-db-uuid1',
    })
    expect((await callWrapped({ ref: 'default' })).res._getJSONData()).toEqual({ host: 'db' })
  })

  it('answers 404 for a ref the registry does not hold, without running the handler', async () => {
    const { res, handler } = await callWrapped({ ref: 'nope' })

    expect(handler).not.toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ error: { message: 'Project nope not found' } })
  })

  it('takes the ref from the body when the route has none', async () => {
    const { res } = await callWrapped({}, { projectRef: 'proj1' })
    expect(res._getJSONData()).toEqual({ host: 'supabase-db-uuid1' })
  })

  it('refuses to guess a project for code running outside any request context', () => {
    expect(() => projectEnv('POSTGRES_HOST')).toThrow(/no project/i)
  })

  it('reports a context failure with its message through apiWrapper', () => {
    let error: unknown
    try {
      projectEnv('POSTGRES_HOST')
    } catch (caught) {
      error = caught
    }
    expect(JSON.parse(JSON.stringify({ error }))).toEqual({
      error: { message: expect.stringMatching(/no project/i) },
    })
  })

  it('never lends the default project a value another project leaves out', async () => {
    await runWithProject('proj1', () => {
      expect(projectEnv('SUPABASE_PUBLISHABLE_KEY')).toBeUndefined()
    })
    await runWithProject('default', () => {
      expect(projectEnv('SUPABASE_PUBLISHABLE_KEY')).toBe('default-publishable')
    })
  })

  it('derives tenant ids and config directories from the ref', async () => {
    await runWithProject('proj1', () => {
      expect(projectEnv('POOLER_TENANT_ID')).toBe('proj1')
      expect(projectEnv('REALTIME_TENANT_ID')).toBe('proj1')
      expect(projectEnv('GOTRUE_CONFIG_DIR')).toBe('/data/projects/proj1/gotrue')
      expect(projectEnv('STORAGE_CONFIG_DIR')).toBe('/data/projects/proj1/storage')
      expect(projectEnv('STUDIO_AUTH_STATE_DIR')).toBe('/data/projects/proj1/state')
    })
  })

  it('keeps the container environment for the default project', async () => {
    vi.stubEnv('POOLER_TENANT_ID', 'dev_tenant')
    await runWithProject('default', () => {
      expect(projectEnv('POOLER_TENANT_ID')).toBe('dev_tenant')
      expect(projectEnv('GOTRUE_CONFIG_DIR')).toBe(process.env.GOTRUE_CONFIG_DIR)
    })
  })

  it('splits the admin secret from the project secret', async () => {
    vi.stubEnv('PLATFORM_ADMIN_JWT_SECRET', 'platform-admin-secret-with-at-least-32-chars')
    await runWithProject('proj1', () => {
      expect(adminJwtSecret()).toBe('platform-admin-secret-with-at-least-32-chars')
      expect(projectJwtSecret()).toBe(PROJ1.AUTH_JWT_SECRET)
    })
    await runWithProject('default', () => {
      expect(adminJwtSecret()).toBe('platform-admin-secret-with-at-least-32-chars')
      expect(projectJwtSecret()).toBe('default-jwt-secret-with-at-least-32-characters')
    })
  })

  it('keeps signing admin tokens with AUTH_JWT_SECRET when PLATFORM_ADMIN_JWT_SECRET is unset', async () => {
    await runWithProject('proj1', () => {
      expect(adminJwtSecret()).toBe('default-jwt-secret-with-at-least-32-characters')
    })
  })
})

describe('registry overrides and validation', () => {
  it('lets the default entry override the container environment', async () => {
    writeRegistry({ projects: { default: { env: { POSTGRES_HOST: 'other-db' } } } })
    await runWithProject('default', () => expect(projectEnv('POSTGRES_HOST')).toBe('other-db'))
  })

  it('always knows the default project, even when the file leaves it out', async () => {
    writeRegistry({ projects: { proj1: { env: PROJ1 } } })
    await runWithProject('default', () => expect(projectEnv('POSTGRES_HOST')).toBe('db'))
  })

  it('puts project directories under /data/pieowl/projects unless told otherwise', async () => {
    writeRegistry({ projects: { proj1: { env: PROJ1 } } })
    await runWithProject('proj1', () =>
      expect(projectEnv('GOTRUE_CONFIG_DIR')).toBe('/data/pieowl/projects/proj1/gotrue')
    )
  })

  it('rejects a project that leaves out a backend it would otherwise share with default', async () => {
    const { SUPABASE_SERVICE_KEY: _omitted, ...withoutServiceKey } = PROJ1
    writeRegistry({ projects: { proj1: { env: withoutServiceKey } } })

    await expect(runWithProject('proj1', () => undefined)).rejects.toThrow(
      /proj1.*SUPABASE_SERVICE_KEY/
    )
  })

  it('rejects a name Studio does not read per project', async () => {
    writeRegistry({ projects: { proj1: { env: { ...PROJ1, POSTGRES_PASS: 'typo' } } } })
    await expect(runWithProject('proj1', () => undefined)).rejects.toThrow(/POSTGRES_PASS/)
  })

  it('rejects a ref that cannot be a host label or a directory name', async () => {
    writeRegistry({ projects: { '../etc': { env: PROJ1 } } })
    await expect(runWithProject('default', () => undefined)).rejects.toThrow(/\.\.\/etc/)
  })

  it('does not echo the file when it is not valid JSON', async () => {
    const path = writeRegistry('{"projects": {"proj1": {"env": {"POSTGRES_PASSWORD": "s3cret"')
    await expect(runWithProject('default', () => undefined)).rejects.toThrow(
      `${path} is not valid JSON`
    )
    await expect(runWithProject('default', () => undefined)).rejects.not.toThrow(/s3cret/)
  })

  it('fails loudly when the file is missing', async () => {
    vi.stubEnv('STUDIO_PROJECT_REGISTRY', join(dir, 'missing.json'))
    await expect(runWithProject('default', () => undefined)).rejects.toThrow(/missing\.json/)
  })
})

describe('the project list', () => {
  it('is default alone without a registry', async () => {
    expect((await listProjects()).map(({ ref, status }) => ({ ref, status }))).toEqual([
      { ref: 'default', status: 'ACTIVE_HEALTHY' },
    ])
  })

  it('is default first, then every project in the file, all running', async () => {
    twoProjects()
    expect((await listProjects()).map(({ ref, name, status }) => ({ ref, name, status }))).toEqual([
      { ref: 'default', name: undefined, status: 'ACTIVE_HEALTHY' },
      { ref: 'proj1', name: 'Project one', status: 'ACTIVE_HEALTHY' },
    ])
  })

  it('accepts PGRST_DB_SCHEMAS per project', async () => {
    writeRegistry({ projects: { proj1: { env: { ...PROJ1, PGRST_DB_SCHEMAS: 'public,api' } } } })
    await runWithProject('proj1', () => expect(projectEnv('PGRST_DB_SCHEMAS')).toBe('public,api'))
  })
})

describe('registry from the control plane', () => {
  const TOKEN = 'cp-token-never-printed'
  const UUID = 'k8s0wkgw4cok8kcogsc0cw8g'
  const REF = 'abcdefghijklmnopqrst'
  const SECRETS = {
    ref: REF,
    db_password: 'cp-db-password',
    jwt_secret: 'cp-jwt-secret-with-at-least-32-characters',
    anon_key: 'cp-anon',
    service_key: 'cp-service',
  }

  let base: string
  let calls: { path: string; authorization: string | null }[]
  let projects: unknown[]
  let failWith: number | undefined

  const project = (overrides: Record<string, unknown> = {}) => ({
    ref: REF,
    name: 'From the control plane',
    status: 'ACTIVE_HEALTHY',
    coolify_service_uuid: UUID,
    endpoint: `https://${REF}.example.test`,
    internal: null,
    created_at: '2026-10-12T10:00:00.000Z',
    updated_at: '2026-10-12T10:00:00.000Z',
    last_error: null,
    ...overrides,
  })

  beforeEach(() => {
    // A host per test: the registry is cached per URL, so a new URL is a fresh read.
    base = `http://cp-${Math.random().toString(36).slice(2)}.test`
    calls = []
    projects = [project()]
    failWith = undefined
    vi.stubEnv('STUDIO_PROJECT_REGISTRY_URL', base)
    vi.stubEnv('STUDIO_PROJECT_REGISTRY_TOKEN', TOKEN)
    vi.stubEnv('STUDIO_PROJECT_DOMAIN_SUFFIX', 'example.test')
    mswServer.use(
      http.get(`${base}/projects`, ({ request }) => {
        calls.push({ path: '/projects', authorization: request.headers.get('authorization') })
        if (failWith) return HttpResponse.json({ error: 'down' }, { status: failWith })
        return HttpResponse.json(projects)
      }),
      http.get(`${base}/projects/:ref/secrets`, ({ request, params }) => {
        calls.push({
          path: `/projects/${params.ref}/secrets`,
          authorization: request.headers.get('authorization'),
        })
        return HttpResponse.json({ ...SECRETS, ref: params.ref })
      })
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is multi-project', () => {
    expect(isMultiProject()).toBe(true)
  })

  it('maps a project to its db container, its public gateway and its secrets', async () => {
    await runWithProject(REF, () => {
      expect(projectPostgres()).toMatchObject({
        host: `supabase-db-${UUID}`,
        password: 'cp-db-password',
      })
      expect(projectEnv('SUPABASE_URL')).toBe(`https://${REF}.example.test`)
      expect(projectEnv('SUPABASE_PUBLIC_URL')).toBe(`https://${REF}.example.test`)
      expect(projectEnv('SUPABASE_ANON_KEY')).toBe('cp-anon')
      expect(projectEnv('SUPABASE_SERVICE_KEY')).toBe('cp-service')
      expect(projectJwtSecret()).toBe(SECRETS.jwt_secret)
      expect(projectEnv('GOTRUE_CONFIG_DIR')).toBe(`/data/pieowl/projects/${REF}/gotrue`)
    })
  })

  it('sends the bearer token on every call', async () => {
    await listProjects()
    expect(calls).toEqual([
      { path: '/projects', authorization: `Bearer ${TOKEN}` },
      { path: `/projects/${REF}/secrets`, authorization: `Bearer ${TOKEN}` },
    ])
  })

  it('keeps default on the container environment', async () => {
    await runWithProject('default', () => expect(projectEnv('POSTGRES_HOST')).toBe('db'))
    expect((await listProjects()).map(({ ref, name, status }) => ({ ref, name, status }))).toEqual([
      { ref: 'default', name: undefined, status: 'ACTIVE_HEALTHY' },
      { ref: REF, name: 'From the control plane', status: 'ACTIVE_HEALTHY' },
    ])
  })

  it('gives default nothing from the container on a platform stack (STUDIO_DEFAULT_PROJECT=none)', async () => {
    vi.stubEnv('STUDIO_DEFAULT_PROJECT', 'none')

    expect((await listProjects())[0]).toMatchObject({ ref: 'default', status: 'REMOVED' })
    await runWithProject('default', () => {
      // The container still holds POSTGRES_HOST=db and SUPABASE_URL here; none of it is used.
      expect(() => projectPostgres()).toThrow(/default has no stack/)
      expect(() => projectEnv('SUPABASE_URL')).toThrow(/STUDIO_DEFAULT_PROJECT=none/)
      expect(projectEnv('SUPABASE_PUBLISHABLE_KEY')).toBeUndefined()
    })
    // The control plane's projects are untouched.
    await runWithProject(REF, () => expect(projectPostgres().host).toBe(`supabase-db-${UUID}`))
  })

  it('answers 404 for a ref the control plane does not hold', async () => {
    const { res, handler } = await callWrapped({ ref: 'zzzzzzzzzzzzzzzzzzzz' })
    expect(handler).not.toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(404)
  })

  it('lists a project that has no stack yet as coming up, and refuses its backends', async () => {
    projects = [project({ status: 'CREATING', coolify_service_uuid: null })]

    expect((await listProjects())[1]).toMatchObject({ ref: REF, status: 'COMING_UP' })
    expect(calls.map(({ path }) => path)).toEqual(['/projects'])
    await runWithProject(REF, () => {
      expect(projectEnv('SUPABASE_PUBLIC_URL')).toBe(`https://${REF}.example.test`)
      expect(() => projectPostgres()).toThrow(new RegExp(`${REF}.*POSTGRES_HOST`))
      expect(() => projectEnv('SUPABASE_SERVICE_KEY')).toThrow(/not ready/)
    })
  })

  it('lists a project being deleted as going down, and refuses its backends', async () => {
    projects = [project({ status: 'DELETING' })]

    expect((await listProjects())[1]).toMatchObject({ ref: REF, status: 'GOING_DOWN' })
    expect(calls.map(({ path }) => path)).toEqual(['/projects'])
    await runWithProject(REF, () => {
      expect(() => projectPostgres()).toThrow(/not ready \(GOING_DOWN\)/)
    })
  })

  it('reports a failed provisioning as INIT_FAILED', async () => {
    projects = [project({ status: 'FAILED' })]
    expect((await listProjects())[1].status).toBe('INIT_FAILED')
  })

  it('asks the control plane again only after the cache expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await listProjects()
    await runWithProject(REF, () => undefined)
    expect(calls.filter(({ path }) => path === '/projects')).toHaveLength(1)

    vi.setSystemTime(Date.now() + 11_000)
    await listProjects()
    expect(calls.filter(({ path }) => path === '/projects')).toHaveLength(2)
  })

  it('keeps serving the last good registry while the control plane fails, and logs it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await listProjects()

    failWith = 503
    vi.setSystemTime(Date.now() + 11_000)
    await runWithProject(REF, () => expect(projectEnv('SUPABASE_ANON_KEY')).toBe('cp-anon'))

    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/\/projects answered 503/))
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TOKEN)
  })

  it('fails without a last good registry, and never falls back to default', async () => {
    failWith = 500
    // apiWrapper turns this rejection into a 500 carrying the message; no handler runs.
    await expect(callWrapped({ ref: REF })).rejects.toThrow(/\/projects answered 500/)
    await expect(listProjects()).rejects.not.toThrow(TOKEN)
  })

  it('needs a token and a domain suffix', async () => {
    vi.stubEnv('STUDIO_PROJECT_REGISTRY_TOKEN', undefined)
    await expect(listProjects()).rejects.toThrow(/STUDIO_PROJECT_REGISTRY_TOKEN/)

    vi.stubEnv('STUDIO_PROJECT_REGISTRY_TOKEN', TOKEN)
    vi.stubEnv('STUDIO_PROJECT_DOMAIN_SUFFIX', undefined)
    await expect(listProjects()).rejects.toThrow(/STUDIO_PROJECT_DOMAIN_SUFFIX/)
  })

  it('asks the control plane again right after an invalidation', async () => {
    await listProjects()
    invalidateProjectRegistry()
    await listProjects()
    expect(calls.filter(({ path }) => path === '/projects')).toHaveLength(2)
  })

  it('does not cache a load that started before an invalidation', async () => {
    const before = listProjects()
    invalidateProjectRegistry()
    expect((await before).map(({ ref }) => ref)).toEqual(['default', REF])

    projects = []
    expect((await listProjects()).map(({ ref }) => ref)).toEqual(['default'])
  })

  it('keeps the invalidated registry as the last good one while the control plane fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await listProjects()
    invalidateProjectRegistry()

    failWith = 503
    expect((await listProjects()).map(({ ref }) => ref)).toEqual(['default', REF])
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/\/projects answered 503/))
  })

  it('refuses a registry file and a control plane at once', async () => {
    writeRegistry({ projects: {} })
    await expect(listProjects()).rejects.toThrow(/not both/)
  })
})
