import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'crypto-js'
import { http, HttpResponse } from 'msw'
import type { NextApiRequest, NextApiResponse } from 'next'
import { createMocks, type RequestMethod } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import otpHandler from '../../../../pages/api/platform/auth/[ref]/otp'
import createUserHandler from '../../../../pages/api/platform/auth/[ref]/users/index'
import queryHandler from '../../../../pages/api/platform/pg-meta/[ref]/query/index'
import configHandler from '../../../../pages/api/platform/projects/[ref]/config/index'
import settingsHandler from '../../../../pages/api/platform/projects/[ref]/settings'
import signHandler from '../../../../pages/api/platform/storage/[ref]/buckets/[id]/objects/sign'
import bucketsHandler from '../../../../pages/api/platform/storage/[ref]/buckets/index'
import apiKeysHandler from '../../../../pages/api/v1/projects/[ref]/api-keys'
import { ENCRYPTION_KEY } from '@/lib/api/self-hosted/constants'
import { runWithProject } from '@/lib/api/self-hosted/project-context'
import { getSupavisorConfig } from '@/lib/api/self-hosted/service-config/supavisor'
import { mswServer } from '@/tests/lib/msw'

vi.mock('@/lib/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/constants')>()),
  IS_PLATFORM: false,
  PG_META_URL: 'http://pg-meta.test',
}))

/**
 * One Studio, two projects: `default` on the container environment and `proj1` from the registry.
 * Each test drives a real route handler and checks which backend the request reached.
 */

// Hoisted because `constants.ts` reads the container environment once, at import, and the
// single-project path still answers from those constants.
const DEFAULT_ENV = vi.hoisted(() => {
  const env = {
    POSTGRES_HOST: 'db',
    POSTGRES_PASSWORD: 'default-db-password',
    SUPABASE_URL: 'http://kong.test:8000',
    SUPABASE_PUBLIC_URL: 'https://default.example.test',
    SUPABASE_ANON_KEY: 'default-anon',
    SUPABASE_SERVICE_KEY: 'default-service',
    AUTH_JWT_SECRET: 'default-jwt-secret-with-at-least-32-characters',
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  return env
})

const PROJ1_ENV = {
  POSTGRES_HOST: 'supabase-db-uuid1',
  POSTGRES_PASSWORD: 'proj1-db-password',
  SUPABASE_URL: 'http://proj1.kong.test:8000',
  SUPABASE_PUBLIC_URL: 'https://proj1.example.test',
  SUPABASE_ANON_KEY: 'proj1-anon',
  SUPABASE_SERVICE_KEY: 'proj1-service',
  AUTH_JWT_SECRET: 'proj1-jwt-secret-with-at-least-32-characters',
}

const ADMIN_SECRET = 'platform-admin-secret-with-at-least-32-chars'

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>

const call = async (
  handler: Handler,
  {
    method = 'GET',
    query,
    body,
  }: { method?: RequestMethod; query: Record<string, string>; body?: Record<string, unknown> }
) => {
  const { req, res } = createMocks({ method, query, body })
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse)
  return res
}

/** Every request MSW sees, so a test can say which backend was reached and with which key. */
const seen: Request[] = []
const record = (request: Request) => {
  seen.push(request.clone())
}

const decryptConnection = (request: Request) =>
  crypto.AES.decrypt(request.headers.get('x-connection-encrypted')!, ENCRYPTION_KEY).toString(
    crypto.enc.Utf8
  )

let dir: string

beforeEach(() => {
  seen.length = 0
  dir = mkdtempSync(join(tmpdir(), 'multi-project-'))
  for (const [name, value] of Object.entries(DEFAULT_ENV)) vi.stubEnv(name, value)
  vi.stubEnv('PLATFORM_ADMIN_JWT_SECRET', undefined)

  const registry = join(dir, 'registry.json')
  writeFileSync(
    registry,
    JSON.stringify({ projects: { default: {}, proj1: { name: 'Project one', env: PROJ1_ENV } } })
  )
  vi.stubEnv('STUDIO_PROJECT_REGISTRY', registry)

  mswServer.use(
    http.post('http://pg-meta.test/query', ({ request }) => {
      record(request)
      return HttpResponse.json([])
    }),
    http.post('http://:host/auth/v1/otp', ({ request }) => {
      record(request)
      return HttpResponse.json({})
    }),
    http.post('http://:host/auth/v1/admin/users', ({ request }) => {
      record(request)
      return HttpResponse.json({ id: 'user-1', email: 'a@example.test' })
    }),
    http.get('http://:host/storage/v1/bucket', ({ request }) => {
      record(request)
      return HttpResponse.json([])
    }),
    http.post('http://:host/storage/v1/object/sign/:bucket/:path', ({ request }) => {
      record(request)
      return HttpResponse.json({ signedURL: '/object/sign/avatars/a.png?token=t' })
    })
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('pg-meta query', () => {
  it.each([
    ['proj1', 'postgresql://supabase_admin:proj1-db-password@supabase-db-uuid1:5432/postgres'],
    ['default', 'postgresql://supabase_admin:default-db-password@db:5432/postgres'],
  ])('sends the %s database to pg-meta', async (ref, connection) => {
    const res = await call(queryHandler, {
      method: 'POST',
      query: { ref },
      body: { query: 'select 1' },
    })

    expect(res._getStatusCode()).toBe(200)
    expect(seen).toHaveLength(1)
    expect(decryptConnection(seen[0])).toBe(connection)
  })

  it('answers 404 for an unknown ref and reaches no database', async () => {
    const res = await call(queryHandler, {
      method: 'POST',
      query: { ref: 'nope' },
      body: { query: 'select 1' },
    })

    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ error: { message: 'Project nope not found' } })
    expect(seen).toHaveLength(0)
  })

  it('sends the container database when no registry is configured, whatever the ref', async () => {
    vi.stubEnv('STUDIO_PROJECT_REGISTRY', undefined)

    const res = await call(queryHandler, {
      method: 'POST',
      query: { ref: 'proj1' },
      body: { query: 'select 1' },
    })

    expect(res._getStatusCode()).toBe(200)
    expect(decryptConnection(seen[0])).toBe(
      'postgresql://supabase_admin:default-db-password@db:5432/postgres'
    )
  })
})

describe('GoTrue admin', () => {
  it.each([
    ['proj1', 'proj1.kong.test:8000', 'proj1-service'],
    ['default', 'kong.test:8000', 'default-service'],
  ])('creates a %s user on that project', async (ref, host, serviceKey) => {
    const res = await call(createUserHandler, {
      method: 'POST',
      query: { ref },
      body: { email: 'a@example.test' },
    })

    expect(res._getStatusCode()).toBe(200)
    expect(new URL(seen[0].url).host).toBe(host)
    expect(seen[0].headers.get('apikey')).toBe(serviceKey)
  })

  it('sends an OTP through proj1', async () => {
    const res = await call(otpHandler, {
      method: 'POST',
      query: { ref: 'proj1' },
      body: { phone: '+15550000000' },
    })

    expect(res._getStatusCode()).toBe(200)
    expect(seen[0].url).toBe('http://proj1.kong.test:8000/auth/v1/otp')
    expect(seen[0].headers.get('authorization')).toBe('Bearer proj1-service')
  })
})

describe('storage', () => {
  it.each([
    ['proj1', 'proj1.kong.test:8000'],
    ['default', 'kong.test:8000'],
  ])('lists %s buckets from that project', async (ref, host) => {
    const res = await call(bucketsHandler, { query: { ref } })

    expect(res._getStatusCode()).toBe(200)
    expect(new URL(seen[0].url).host).toBe(host)
  })

  it.each([
    ['proj1', 'https://proj1.example.test/storage/v1/object/sign/avatars/a.png?token=t'],
    ['default', 'https://default.example.test/storage/v1/object/sign/avatars/a.png?token=t'],
  ])('signs a %s URL on that project public host', async (ref, signedUrl) => {
    const res = await call(signHandler, {
      method: 'POST',
      query: { ref, id: 'avatars' },
      body: { path: 'a.png' },
    })

    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData().signedUrl).toBe(signedUrl)
  })
})

describe('settings and keys', () => {
  it('reports proj1 settings, keys and JWT secret', async () => {
    const res = await call(settingsHandler, { query: { ref: 'proj1' } })
    const settings = res._getJSONData()

    expect(settings).toMatchObject({
      ref: 'proj1',
      name: 'Project one',
      db_host: 'proj1.example.test',
      jwt_secret: PROJ1_ENV.AUTH_JWT_SECRET,
      app_config: { endpoint: 'proj1.example.test', protocol: 'https' },
    })
    expect(settings.service_api_keys.map((key: { api_key: string }) => key.api_key)).toEqual([
      'proj1-anon',
      'proj1-service',
    ])
  })

  it('reports the default settings unchanged', async () => {
    const res = await call(settingsHandler, { query: { ref: 'default' } })

    expect(res._getJSONData()).toMatchObject({
      ref: 'default',
      db_host: 'default.example.test',
      jwt_secret: DEFAULT_ENV.AUTH_JWT_SECRET,
    })
  })

  it('reports the proj1 JWT secret in the PostgREST config', async () => {
    const res = await call(configHandler, { query: { ref: 'proj1' } })
    expect(res._getJSONData().jwt_secret).toBe(PROJ1_ENV.AUTH_JWT_SECRET)
  })

  it('lists the proj1 API keys', async () => {
    const res = await call(apiKeysHandler, { query: { ref: 'proj1', reveal: 'true' } })
    expect(res._getJSONData().map((key: { api_key: string }) => key.api_key)).toEqual([
      'proj1-anon',
      'proj1-service',
    ])
  })
})

describe('shared admin APIs', () => {
  const verifies = (token: string, secret: string) => {
    const [header, claims, signature] = token.split('.')
    return (
      createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url') === signature
    )
  }

  it('asks Supavisor for the proj1 tenant with the platform admin secret, not the project one', async () => {
    vi.stubEnv('PLATFORM_ADMIN_JWT_SECRET', ADMIN_SECRET)
    mswServer.use(
      http.get('http://supabase-supavisor:4000/api/tenants/:tenant', ({ request }) => {
        record(request)
        return HttpResponse.json({
          data: {
            external_id: 'proj1',
            db_host: 'supabase-db-uuid1',
            db_port: 5432,
            db_database: 'postgres',
            default_pool_size: 20,
            default_max_clients: 200,
            users: [{ db_user: 'postgres', mode_type: 'transaction', pool_size: 20 }],
          },
        })
      })
    )

    const [config] = await runWithProject('proj1', () => getSupavisorConfig())

    expect(seen[0].url).toBe('http://supabase-supavisor:4000/api/tenants/proj1')
    const token = seen[0].headers.get('authorization')!.replace('Bearer ', '')
    expect(verifies(token, ADMIN_SECRET)).toBe(true)
    expect(verifies(token, PROJ1_ENV.AUTH_JWT_SECRET)).toBe(false)
    expect(config.db_user).toBe('postgres.proj1')
    expect(config.connection_string).toContain('@proj1.example.test:')
  })
})
