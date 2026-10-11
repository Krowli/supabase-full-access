import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'

import { fetchControlPlaneProjects } from './control-plane-registry'
import { mswServer } from '@/tests/lib/msw'

const BASE = 'http://control-plane.test'
const CONFIG = { url: `${BASE}/`, token: 'cp-token', domainSuffix: 'pieowl.test' }

const SECRETS = {
  db_password: 'db-pass',
  jwt_secret: 'jwt-secret',
  anon_key: 'anon',
  service_key: 'service',
}

const project = (ref: string, overrides: Record<string, unknown> = {}) => ({
  ref,
  name: `Project ${ref}`,
  status: 'ACTIVE_HEALTHY',
  coolify_service_uuid: `uuid${ref.slice(0, 4)}`,
  created_at: '2026-10-12T10:00:00.000Z',
  ...overrides,
})

const serve = (
  projects: unknown,
  secrets: (ref: string) => Response = () => HttpResponse.json(SECRETS)
) =>
  mswServer.use(
    http.get(`${BASE}/projects`, () => HttpResponse.json(projects)),
    http.get(`${BASE}/projects/:ref/secrets`, ({ params }) => secrets(String(params.ref)))
  )

describe('fetchControlPlaneProjects', () => {
  beforeEach(() => {
    serve([])
  })

  it('maps each project to the env a registry file would hold', async () => {
    serve([project('aaaaaaaaaaaaaaaaaaaa')])

    expect(await fetchControlPlaneProjects(CONFIG)).toEqual([
      {
        ref: 'aaaaaaaaaaaaaaaaaaaa',
        name: 'Project aaaaaaaaaaaaaaaaaaaa',
        status: 'ACTIVE_HEALTHY',
        insertedAt: '2026-10-12T10:00:00.000Z',
        env: {
          POSTGRES_HOST: 'supabase-db-uuidaaaa',
          POSTGRES_PASSWORD: 'db-pass',
          SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.pieowl.test',
          SUPABASE_PUBLIC_URL: 'https://aaaaaaaaaaaaaaaaaaaa.pieowl.test',
          SUPABASE_ANON_KEY: 'anon',
          SUPABASE_SERVICE_KEY: 'service',
          AUTH_JWT_SECRET: 'jwt-secret',
        },
      },
    ])
  })

  it.each([
    ['CREATING', 'COMING_UP'],
    ['COMING_UP', 'COMING_UP'],
    ['ACTIVE_HEALTHY', 'ACTIVE_HEALTHY'],
    ['FAILED', 'INIT_FAILED'],
    ['SOMETHING_NEW', 'UNKNOWN'],
  ])('reports %s as %s', async (status, expected) => {
    serve([project('bbbbbbbbbbbbbbbbbbbb', { status })])
    expect((await fetchControlPlaneProjects(CONFIG))[0].status).toBe(expected)
  })

  it('asks for no secrets of a project without a stack', async () => {
    serve([project('cccccccccccccccccccc', { coolify_service_uuid: null })], () =>
      HttpResponse.json({ error: 'should not be asked' }, { status: 500 })
    )

    expect((await fetchControlPlaneProjects(CONFIG))[0].env).toEqual({
      SUPABASE_URL: 'https://cccccccccccccccccccc.pieowl.test',
      SUPABASE_PUBLIC_URL: 'https://cccccccccccccccccccc.pieowl.test',
    })
  })

  it('fails as a whole when one project secrets cannot be read', async () => {
    serve([project('dddddddddddddddddddd'), project('eeeeeeeeeeeeeeeeeeee')], (ref) =>
      ref === 'eeeeeeeeeeeeeeeeeeee'
        ? HttpResponse.json({ error: 'Project not found' }, { status: 404 })
        : HttpResponse.json(SECRETS)
    )

    await expect(fetchControlPlaneProjects(CONFIG)).rejects.toThrow(
      'control plane GET /projects/eeeeeeeeeeeeeeeeeeee/secrets answered 404'
    )
  })

  it('names the fields of a bad answer but never their values', async () => {
    serve([project('ffffffffffffffffffff')], () =>
      HttpResponse.json({ ...SECRETS, db_password: '' })
    )

    const error = await fetchControlPlaneProjects(CONFIG).catch((caught) => caught)
    expect(error.message).toBe(
      'control plane GET /projects/ffffffffffffffffffff/secrets is invalid at db_password'
    )
  })

  it.each([
    ['a ref that is not a host label', { ref: '../etc' }],
    ['the default ref', { ref: 'default' }],
    ['a uuid that is not a host label', { coolify_service_uuid: 'a b' }],
  ])('refuses %s', async (_case, overrides) => {
    serve([project('gggggggggggggggggggg', overrides)])
    await expect(fetchControlPlaneProjects(CONFIG)).rejects.toThrow(/\/projects is invalid at 0\./)
  })

  it('reports a control plane that cannot be reached', async () => {
    mswServer.use(http.get(`${BASE}/projects`, () => HttpResponse.error()))
    await expect(fetchControlPlaneProjects(CONFIG)).rejects.toThrow(
      /^control plane GET \/projects failed: /
    )
  })
})
