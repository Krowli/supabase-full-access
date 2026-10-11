import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMocks } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AUTH_JWT_SECRET } from './constants'
import {
  adminJwtSecret,
  isMultiProject,
  projectEnv,
  projectJwtSecret,
  projectPostgres,
  runWithProject,
  withProjectContext,
} from './project-context'

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

  it('never lends the default project a value another project leaves out', () => {
    runWithProject('proj1', () => {
      expect(projectEnv('SUPABASE_PUBLISHABLE_KEY')).toBeUndefined()
    })
    runWithProject('default', () => {
      expect(projectEnv('SUPABASE_PUBLISHABLE_KEY')).toBe('default-publishable')
    })
  })

  it('derives tenant ids and config directories from the ref', () => {
    runWithProject('proj1', () => {
      expect(projectEnv('POOLER_TENANT_ID')).toBe('proj1')
      expect(projectEnv('REALTIME_TENANT_ID')).toBe('proj1')
      expect(projectEnv('GOTRUE_CONFIG_DIR')).toBe('/data/projects/proj1/gotrue')
      expect(projectEnv('STORAGE_CONFIG_DIR')).toBe('/data/projects/proj1/storage')
      expect(projectEnv('STUDIO_AUTH_STATE_DIR')).toBe('/data/projects/proj1/state')
    })
  })

  it('keeps the container environment for the default project', () => {
    vi.stubEnv('POOLER_TENANT_ID', 'dev_tenant')
    runWithProject('default', () => {
      expect(projectEnv('POOLER_TENANT_ID')).toBe('dev_tenant')
      expect(projectEnv('GOTRUE_CONFIG_DIR')).toBe(process.env.GOTRUE_CONFIG_DIR)
    })
  })

  it('splits the admin secret from the project secret', () => {
    vi.stubEnv('PLATFORM_ADMIN_JWT_SECRET', 'platform-admin-secret-with-at-least-32-chars')
    runWithProject('proj1', () => {
      expect(adminJwtSecret()).toBe('platform-admin-secret-with-at-least-32-chars')
      expect(projectJwtSecret()).toBe(PROJ1.AUTH_JWT_SECRET)
    })
    runWithProject('default', () => {
      expect(adminJwtSecret()).toBe('platform-admin-secret-with-at-least-32-chars')
      expect(projectJwtSecret()).toBe('default-jwt-secret-with-at-least-32-characters')
    })
  })

  it('keeps signing admin tokens with AUTH_JWT_SECRET when PLATFORM_ADMIN_JWT_SECRET is unset', () => {
    runWithProject('proj1', () => {
      expect(adminJwtSecret()).toBe('default-jwt-secret-with-at-least-32-characters')
    })
  })
})

describe('registry overrides and validation', () => {
  it('lets the default entry override the container environment', () => {
    writeRegistry({ projects: { default: { env: { POSTGRES_HOST: 'other-db' } } } })
    runWithProject('default', () => expect(projectEnv('POSTGRES_HOST')).toBe('other-db'))
  })

  it('always knows the default project, even when the file leaves it out', () => {
    writeRegistry({ projects: { proj1: { env: PROJ1 } } })
    runWithProject('default', () => expect(projectEnv('POSTGRES_HOST')).toBe('db'))
  })

  it('puts project directories under /data/pieowl/projects unless told otherwise', () => {
    writeRegistry({ projects: { proj1: { env: PROJ1 } } })
    runWithProject('proj1', () =>
      expect(projectEnv('GOTRUE_CONFIG_DIR')).toBe('/data/pieowl/projects/proj1/gotrue')
    )
  })

  it('rejects a project that leaves out a backend it would otherwise share with default', () => {
    const { SUPABASE_SERVICE_KEY: _omitted, ...withoutServiceKey } = PROJ1
    writeRegistry({ projects: { proj1: { env: withoutServiceKey } } })

    expect(() => runWithProject('proj1', () => undefined)).toThrow(/proj1.*SUPABASE_SERVICE_KEY/)
  })

  it('rejects a name Studio does not read per project', () => {
    writeRegistry({ projects: { proj1: { env: { ...PROJ1, POSTGRES_PASS: 'typo' } } } })
    expect(() => runWithProject('proj1', () => undefined)).toThrow(/POSTGRES_PASS/)
  })

  it('rejects a ref that cannot be a host label or a directory name', () => {
    writeRegistry({ projects: { '../etc': { env: PROJ1 } } })
    expect(() => runWithProject('default', () => undefined)).toThrow(/\.\.\/etc/)
  })

  it('does not echo the file when it is not valid JSON', () => {
    const path = writeRegistry('{"projects": {"proj1": {"env": {"POSTGRES_PASSWORD": "s3cret"')
    expect(() => runWithProject('default', () => undefined)).toThrow(`${path} is not valid JSON`)
    expect(() => runWithProject('default', () => undefined)).not.toThrow(/s3cret/)
  })

  it('fails loudly when the file is missing', () => {
    vi.stubEnv('STUDIO_PROJECT_REGISTRY', join(dir, 'missing.json'))
    expect(() => runWithProject('default', () => undefined)).toThrow(/missing\.json/)
  })
})
