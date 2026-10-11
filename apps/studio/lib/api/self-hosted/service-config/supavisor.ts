import { components } from 'api-types'

import { adminJwtSecret, projectEnv, projectPostgres } from '../project-context'
import { ServiceConfigValidationError, ServiceUnavailableError } from './errors'
import { adminFetch } from './http'
import { signHs256Jwt } from './jwt'

type PgbouncerConfig = components['schemas']['PgbouncerConfigResponse_Output']
type UpdatePgbouncerConfigBody = components['schemas']['UpdatePgbouncerConfigBody']
type SupavisorConfig = components['schemas']['SupavisorConfigResponse_Output']

/**
 * The connection pooling settings, read from and written to Supavisor's own admin API.
 *
 * Self-hosted, "PgBouncer" is Supavisor: one tenant, whose `external_id` is `POOLER_TENANT_ID`, and
 * whose users are the roles clients connect as through the pooler. Studio does not keep a copy of
 * any of it — Supavisor's database is the record, and a `GET` here is a read of what the pooler is
 * actually running on.
 *
 * `PUT /api/tenants/:external_id` is a full changeset, not a patch: the tenant's `changeset/2`
 * calls `validate_required` on `default_parameter_status, external_id, db_host, db_port,
 * db_database, require_user, allow_list`, so a body carrying only the changed field would be
 * rejected. Every update therefore reads the tenant first and sends it back whole with the two
 * numbers replaced. The controller purges its caches and terminates the tenant's pools after a
 * successful write, so a change reaches new client connections without a restart.
 *
 * Verified against supabase/supavisor v2.7.4: `lib/supavisor/tenants/tenant.ex`,
 * `lib/supavisor/tenants/user.ex`, `lib/supavisor_web/router.ex`,
 * `lib/supavisor_web/controllers/tenant_controller.ex`, `lib/supavisor_web/views/{tenant,user}_view.ex`.
 */

/** Supavisor's admin API on the compose network. */
const supavisorUrl = () => process.env.SUPAVISOR_URL || 'http://supabase-supavisor:4000'

/** The one tenant this stack runs. `dev_tenant` is what the compose file ships with. */
const poolerTenantId = () => projectEnv('POOLER_TENANT_ID') || 'dev_tenant'

/** The port clients reach the pooler on in transaction mode. */
const transactionPort = () => Number(process.env.POOLER_PROXY_PORT_TRANSACTION) || 6543

/**
 * The host an operator's own client can reach, as opposed to the compose-internal names every other
 * value here is expressed in. Read inside the function rather than at import so a test can set it;
 * `lib/constants/api.ts` parses the same variable for the browser-facing constants.
 *
 * A `SUPABASE_PUBLIC_URL` that will not parse falls back to `localhost` rather than throwing. The
 * host is one field of a settings page, and failing the whole read over it would take the pool size
 * down with it — a wrong hostname in a connection string an operator can see and correct is the
 * better failure.
 */
const publicHost = () => {
  try {
    return new URL(projectEnv('SUPABASE_PUBLIC_URL') || 'http://localhost:8000').hostname
  } catch {
    return 'localhost'
  }
}

/**
 * A token for one request. Supavisor's `check_auth` plug verifies it with `API_JWT_SECRET`, the
 * platform admin secret (`adminJwtSecret`: `PLATFORM_ADMIN_JWT_SECRET`, else `AUTH_JWT_SECRET`), and
 * `Supavisor.Jwt` rejects a token whose `exp` is not in the future.
 */
const token = () => signHs256Jwt({}, adminJwtSecret())

const tenantUrl = () => `${supavisorUrl()}/api/tenants/${encodeURIComponent(poolerTenantId())}`

type Tenant = Record<string, unknown>
type TenantUser = Record<string, unknown>

const asRecord = (value: unknown): Tenant | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Tenant)
    : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/**
 * The tenant Supavisor holds. `TenantView` wraps it as `{ data: … }` and replaces the association
 * with the serialised users, so `users` is always an array on a tenant that exists.
 *
 * A 200 that carries no tenant is a `ServiceUnavailableError` like any other bad answer from the
 * pooler, not a 500: nothing Studio did is wrong, and `POOLER_TENANT_ID` naming a tenant Supavisor
 * does not have is exactly the misconfiguration the operator needs told to them.
 */
async function getTenant(): Promise<Tenant> {
  const body = await adminFetch(tenantUrl(), { method: 'GET', token: token() })
  const tenant = asRecord(asRecord(body)?.data)

  if (!tenant) {
    throw new ServiceUnavailableError(`Supavisor returned no tenant for ${poolerTenantId()}`)
  }

  return tenant
}

const usersOf = (tenant: Tenant): TenantUser[] =>
  Array.isArray(tenant.users)
    ? tenant.users.map(asRecord).filter((user): user is TenantUser => user !== undefined)
    : []

/**
 * The user whose settings the pooling form edits. Supavisor marks exactly one user per tenant as
 * the manager; the first user is the fallback for a tenant that predates the flag.
 */
const managerOf = (tenant: Tenant): TenantUser | undefined => {
  const users = usersOf(tenant)
  return users.find((user) => user.is_manager === true) ?? users[0]
}

/** Supavisor's `mode_type` is `transaction | session`; the platform's field also allows `statement`. */
function poolMode(tenant: Tenant): 'transaction' | 'session' {
  return managerOf(tenant)?.mode_type === 'session' ? 'session' : 'transaction'
}

/**
 * Where a client reaches the pooler, which is **not** where Supavisor reaches Postgres.
 *
 * The tenant's own `db_host` and `db_port` are the upstream database — in this stack an internal
 * compose name on 5432 — and they are deliberately not exposed through either endpoint. What the UI
 * calls `db_host`/`db_port`/`db_user` is what a client connects to, and the Connect sheet prints
 * those three fields verbatim rather than reading `connection_string`
 * (`ConnectStepsSection.tsx`, `useConnectionStringDatabases.ts`, `DatabaseSettings.utils.ts`). So
 * handing back the upstream address there would put an unroutable host and the wrong port into the
 * connection strings an operator copies.
 *
 * The username carries the tenant id after a dot: that is how Supavisor routes a connection to a
 * tenant when the client cannot send SNI.
 */
const poolerEndpoint = (tenant: Tenant) => ({
  db_host: publicHost(),
  db_name: asString(tenant.db_database) ?? 'postgres',
  db_port: transactionPort(),
  db_user: `postgres.${poolerTenantId()}`,
})

/**
 * What an operator types into a client. The password is left as a placeholder on purpose — it is
 * the one part of this that Studio must not put on a settings page.
 */
const connectionString = (tenant: Tenant): string => {
  const { db_host, db_name, db_port, db_user } = poolerEndpoint(tenant)
  return `postgresql://${db_user}:[YOUR-PASSWORD]@${db_host}:${db_port}/${db_name}`
}

function toPgbouncerConfig(tenant: Tenant): PgbouncerConfig {
  return {
    connection_string: connectionString(tenant),
    db_dns_name: publicHost(),
    ...poolerEndpoint(tenant),
    default_pool_size: asNumber(tenant.default_pool_size),
    // Supavisor has no equivalent setting. The platform's value is echoed so the field the form
    // sends back is the one it was given, and the UI has something to render.
    ignore_startup_parameters: 'options,extra_float_digits',
    // A tenant created before this column was populated has no timestamp; the epoch is a date the
    // UI can format rather than a crash.
    inserted_at: asString(tenant.inserted_at) ?? new Date(0).toISOString(),
    max_client_conn: asNumber(tenant.default_max_clients),
    pgbouncer_enabled: true,
    pool_mode: poolMode(tenant),
    ssl_enforced: tenant.enforce_ssl === true,
    // `query_wait_timeout`, `reserve_pool_size`, `server_idle_timeout` and `server_lifetime` are
    // PgBouncer settings with no Supavisor counterpart, and are left out rather than invented.
  }
}

export async function getPoolerConfig(): Promise<PgbouncerConfig> {
  return toPgbouncerConfig(await getTenant())
}

/**
 * The same tenant, in the shape the Connect sheet and the pooling-mode dialog read. Self-hosted
 * there is one pooler and one database, so the list has exactly one entry, identified by the
 * project ref every self-hosted page uses.
 */
export async function getSupavisorConfig(): Promise<SupavisorConfig[]> {
  const tenant = await getTenant()
  const connection = connectionString(tenant)

  return [
    {
      connection_string: connection,
      // Deprecated alias of the above; both are sent because different call sites read each.
      connectionString: connection,
      database_type: 'PRIMARY',
      // The pooler's address, not the upstream database's — see `poolerEndpoint`.
      ...poolerEndpoint(tenant),
      default_pool_size: asNumber(tenant.default_pool_size) ?? null,
      identifier: 'default',
      // Supavisor authenticates upstream with SCRAM against the Postgres image this stack ships.
      is_using_scram_auth: true,
      max_client_conn: asNumber(tenant.default_max_clients) ?? null,
      pool_mode: poolMode(tenant),
    },
  ]
}

/**
 * A field the form may or may not send. `null` reaches here from a cleared number input, and means
 * the same as an absent key: leave the setting where it is.
 */
function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number
): number | undefined {
  if (value === undefined || value === null) return undefined

  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ServiceConfigValidationError(`${field} must be an integer between ${min} and ${max}`)
  }

  return value
}

/**
 * The users, as `cast_assoc` needs them back.
 *
 * `has_many :users` is declared `on_replace: :delete`, so the `users` key of a `PUT` replaces the
 * whole set — leaving it out would keep the old rows, and every user Supavisor keeps requires
 * `db_user_alias, db_user, db_password, pool_size, mode_type`.
 *
 * `db_password` is resupplied because the changeset requires it. Supavisor's `UserView` does return
 * the decrypted password on a `GET`, so the value that comes back is preferred and
 * `POSTGRES_PASSWORD` is only the fallback: writing the container's env over a password that is
 * already working would break every pooled connection at once.
 *
 * Only the manager user follows the form. Any other user keeps the sizes it was configured with —
 * the form edits one number for the pooler as a whole, and that is not a mandate to flatten users
 * an operator set up by hand.
 */
function toUserPayload(
  users: TenantUser[],
  poolSize: number,
  maxClients: number
): Record<string, unknown>[] {
  return users.map((user) => {
    const isManager = user.is_manager === true

    return {
      db_user: asString(user.db_user) ?? 'postgres',
      db_user_alias: asString(user.db_user_alias) ?? asString(user.db_user) ?? 'postgres',
      db_password: asString(user.db_password) ?? projectPostgres().password,
      is_manager: isManager,
      mode_type: asString(user.mode_type) ?? 'transaction',
      pool_checkout_timeout: asNumber(user.pool_checkout_timeout) ?? 60_000,
      pool_size: isManager ? poolSize : (asNumber(user.pool_size) ?? poolSize),
      max_clients: isManager ? maxClients : (asNumber(user.max_clients) ?? maxClients),
    }
  })
}

/**
 * Writes the pool sizes and hands back the configuration as it now stands.
 *
 * `id`, `inserted_at` and `updated_at` are dropped from what the `GET` returned: they are the
 * server's to set, and the tenant changeset does not cast them. Everything else is sent back
 * unchanged, which is what makes a full-changeset `PUT` behave like the patch the UI thinks it is
 * sending.
 *
 * **Only `default_pool_size` and `max_client_conn` are acted on.** The rest of
 * `UpdatePgbouncerConfigBody` is accepted and ignored, so a client saving the whole form is not
 * refused for sending fields the platform's contract has:
 *
 * - `pool_mode` is not a tenant setting at all. In Supavisor the mode is `mode_type` on each user,
 *   set when the tenant and its manager user are seeded, and it is carried through a write
 *   untouched — see {@link toUserPayload}. A `pool_mode` in the body moves nothing; the form does
 *   not send one, and the platform marks the field deprecated.
 * - `ignore_startup_parameters` and `pgbouncer_enabled` have no Supavisor counterpart; the `GET`
 *   answers with fixed values for both and the form echoes them straight back.
 * - `query_wait_timeout`, `reserve_pool_size`, `server_idle_timeout` and `server_lifetime` are
 *   PgBouncer settings the `GET` does not answer with either.
 */
export async function updatePoolerConfig(
  body: UpdatePgbouncerConfigBody
): Promise<PgbouncerConfig> {
  // The body is parsed JSON from a request, so it is read as unknown rather than trusted as typed.
  const fields = { ...body } as Record<string, unknown>
  const requestedPoolSize = optionalInteger(fields.default_pool_size, 'default_pool_size', 1, 1000)
  const requestedMaxClients = optionalInteger(fields.max_client_conn, 'max_client_conn', 1, 10000)

  const tenant = await getTenant()
  const {
    id: _id,
    inserted_at: _insertedAt,
    updated_at: _updatedAt,
    users: _users,
    ...rest
  } = tenant

  const poolSize = requestedPoolSize ?? asNumber(tenant.default_pool_size) ?? 15
  const maxClients = requestedMaxClients ?? asNumber(tenant.default_max_clients) ?? 1000

  await adminFetch(tenantUrl(), {
    method: 'PUT',
    token: token(),
    body: JSON.stringify({
      tenant: {
        ...rest,
        default_pool_size: poolSize,
        default_max_clients: maxClients,
        users: toUserPayload(usersOf(tenant), poolSize, maxClients),
      },
    }),
  })

  // Read back rather than echo the request: the answer then describes what Supavisor kept.
  return getPoolerConfig()
}
