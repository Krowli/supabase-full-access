// Tenant registration in the shared Supavisor and Realtime (deploy/platform/SPEC.md §5, §8).
// Both admin APIs take an HS256 bearer token signed with their API_JWT_SECRET, which is the
// platform-wide PLATFORM_ADMIN_JWT_SECRET (never a project's JWT secret).

import { signJwt } from './secrets.ts'

/** What a shared service needs to reach one project's database. */
export type TenantTarget = {
  ref: string
  /** The project db container on the `coolify` network: supabase-db-<coolify-service-uuid>. */
  dbHost: string
  dbPassword: string
  /** The project's JWT secret; Realtime verifies client tokens with it. */
  jwtSecret: string
}

/** One shared multi-tenant service. Both calls are idempotent. */
export interface TenantRegistry {
  ensure(target: TenantTarget): Promise<void>
  remove(ref: string): Promise<void>
}

export type AdminApiConfig = { url: string; adminJwtSecret: string }

function adminCaller(service: string, config: AdminApiConfig) {
  const base = config.url.replace(/\/+$/, '')
  return async (method: string, path: string, body?: unknown) => {
    const iat = Math.floor(Date.now() / 1000)
    const token = signJwt(
      { role: 'service_role', iss: 'platform', iat, exp: iat + 300 },
      config.adminJwtSecret
    )
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    // Error bodies echo field names and validation messages, not the submitted values.
    const text = await res.text()
    return {
      status: res.status,
      text,
      fail: () => new Error(`${service} ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`),
    }
  }
}

/**
 * Supavisor: PUT /api/tenants/<ref> upserts. Clients connect as `<role>.<ref>` with any role of
 * the project database, as on supabase.com: `require_user: false` makes Supavisor check the
 * password with auth_query, run as the manager `pgbouncer` (project-compose sets its password to
 * the project db password at init). Session mode on port 5432, transaction mode on 6543.
 */
export function createSupavisorTenants(config: AdminApiConfig): TenantRegistry {
  const call = adminCaller('Supavisor', config)
  return {
    async ensure(t) {
      const res = await call('PUT', `/api/tenants/${t.ref}`, {
        tenant: {
          db_host: t.dbHost,
          db_port: 5432,
          db_database: 'postgres',
          ip_version: 'auto',
          require_user: false,
          auth_query: 'SELECT * FROM pgbouncer.get_auth($1)',
          upstream_ssl: false,
          enforce_ssl: false,
          default_max_clients: 100,
          default_pool_size: 10,
          users: [
            {
              db_user: 'pgbouncer',
              db_password: t.dbPassword,
              pool_size: 10,
              mode_type: 'transaction',
              is_manager: true,
            },
          ],
        },
      })
      if (res.status !== 200 && res.status !== 201) throw res.fail()
    },
    async remove(ref) {
      const res = await call('DELETE', `/api/tenants/${ref}`)
      if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw res.fail()
    },
  }
}

/**
 * Realtime: POST /api/tenants creates; an existing tenant is left as it is. Realtime picks the
 * tenant from the first label of the Host header, so Kong preserves `<ref>.<suffix>`.
 */
export function createRealtimeTenants(config: AdminApiConfig): TenantRegistry {
  const call = adminCaller('Realtime', config)
  return {
    async ensure(t) {
      const existing = await call('GET', `/api/tenants/${t.ref}`)
      if (existing.status === 200) return
      if (existing.status !== 404) throw existing.fail()
      const res = await call('POST', '/api/tenants', {
        tenant: {
          name: t.ref,
          external_id: t.ref,
          jwt_secret: t.jwtSecret,
          extensions: [
            {
              type: 'postgres_cdc_rls',
              settings: {
                db_name: 'postgres',
                db_host: t.dbHost,
                db_user: 'supabase_admin',
                db_password: t.dbPassword,
                db_port: '5432',
                region: 'us-east-1',
                poll_interval_ms: 100,
                poll_max_record_bytes: 1048576,
                ssl_enforced: false,
              },
            },
          ],
        },
      })
      if (res.status !== 201 && res.status !== 200) throw res.fail()
    },
    async remove(ref) {
      const res = await call('DELETE', `/api/tenants/${ref}`)
      if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw res.fail()
    },
  }
}
