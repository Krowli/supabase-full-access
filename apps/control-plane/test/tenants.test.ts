import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSupavisorTenants } from '../src/tenants.ts'

const target = {
  ref: 'aaaaaaaaaaaaaaaaaaaa',
  dbHost: 'supabase-db-uuida',
  dbPassword: 'db-password',
  jwtSecret: 'jwt-secret',
}

afterEach(() => vi.unstubAllGlobals())

describe('createSupavisorTenants', () => {
  it('lets any database role in as <role>.<ref>, checked by the project db (auth_query)', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    await createSupavisorTenants({ url: 'http://supavisor:4000', adminJwtSecret: 's' }).ensure(target)

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`http://supavisor:4000/api/tenants/${target.ref}`)
    expect(init.method).toBe('PUT')
    const { tenant } = JSON.parse(String(init.body))
    expect(tenant).toMatchObject({
      db_host: 'supabase-db-uuida',
      require_user: false,
      auth_query: 'SELECT * FROM pgbouncer.get_auth($1)',
    })
    // The manager runs auth_query; its password is the project db password (project-compose
    // sets pgbouncer's password to it at init).
    expect(tenant.users).toEqual([
      expect.objectContaining({ db_user: 'pgbouncer', db_password: 'db-password', is_manager: true }),
    ])
  })
})
