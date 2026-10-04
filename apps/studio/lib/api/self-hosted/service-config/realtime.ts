import { components } from 'api-types'

import { readJsonState, writeJsonState } from '../auth-config/state'
import { AUTH_JWT_SECRET } from '../constants'
import { executeQuery } from '../query'
import { ServiceConfigValidationError, ServiceUnavailableError } from './errors'
import { adminFetch } from './http'
import { signHs256Jwt } from './jwt'

type RealtimeConfig = components['schemas']['RealtimeConfigResponse_Output']
type UpdateRealtimeConfigBody = components['schemas']['UpdateRealtimeConfigBody']

/**
 * The Realtime settings: read from Realtime's own tenant row, written through its admin API, and
 * remembered here.
 *
 * Self-hosted there is one tenant, `REALTIME_TENANT_ID`, and `PUT /api/tenants/:tenant_id` writes
 * the columns behind this page. The controller updates the global tenant cache and disconnects or
 * restarts what the change requires, so a save applies without a restart. Writes go through the API
 * for exactly that reason: an `UPDATE` straight against the table would move the row and leave every
 * running node serving the cached old one.
 *
 * **Studio keeps its own copy, and that is not belt-and-braces.** The self-hosted compose `command`
 * runs `Realtime.Release.seeds` on every container start, and `priv/repo/seeds.exs` *deletes* the
 * tenant and inserts it again with nothing but a name, a JWT secret and the CDC extension. Every
 * rate limit therefore returns to its default the next time Realtime restarts, and whatever the
 * operator saved is gone. So a read compares the tenant against what was saved and re-applies the
 * difference.
 *
 * **Reads come from the table, because the API cannot answer them in full.**
 * `TenantView.render("tenant.json")` serialises five of the nine columns this module writes —
 * `max_concurrent_users`, `max_channels_per_client`, `max_events_per_second`, `max_joins_per_second`
 * and `private_only`. It never returns `max_bytes_per_second`, `max_presence_events_per_second`,
 * `max_payload_size_in_kb` or `suspend`, all four of which the changeset casts and two of which the
 * settings form edits. Reading `_realtime.tenants` sees all nine, so drift is compared exactly per
 * key and a tenant that already matches is left alone.
 *
 * The admin API read stays as the fallback for a stack where that table cannot be reached — a
 * Realtime on its own database, say. On that path the four columns above come back absent, and
 * {@link hasDrifted} treats an absent column as drifted, which is what keeps a saved value applied
 * when it cannot be verified. The `PUT` is idempotent — Ecto produces an empty changeset when
 * nothing moved, and neither the cache update nor the client disconnect fires on one — so
 * re-applying costs one request and disturbs nobody.
 *
 * Verified against supabase/realtime v2.76.5: `lib/realtime/api/tenant.ex`, `lib/realtime/api.ex`,
 * `lib/realtime_web/router.ex`, `lib/realtime_web/controllers/tenant_controller.ex`,
 * `lib/realtime_web/views/tenant_view.ex`, `priv/repo/seeds.exs`, `config/runtime.exs`.
 */

/** Where Studio remembers what the Realtime settings page saved. */
export const REALTIME_STATE_FILE_NAME = 'realtime-config.json'

/** Realtime's admin API on the compose network. */
const realtimeUrl = () => process.env.REALTIME_URL || 'http://realtime-dev:4000'

/** The one tenant this stack runs. `realtime-dev` is what the compose file seeds. */
const realtimeTenantId = () => process.env.REALTIME_TENANT_ID || 'realtime-dev'

const tenantUrl = () => `${realtimeUrl()}/api/tenants/${encodeURIComponent(realtimeTenantId())}`

/**
 * A token for one request. Realtime's `check_auth` plug verifies it with `API_JWT_SECRET`, which in
 * this stack is the same string Studio holds as `AUTH_JWT_SECRET`, and requires an `exp` in the
 * future.
 */
const token = () => signHs256Jwt({}, AUTH_JWT_SECRET)

/** Tenant columns the settings page owns and writes, split by the type each one holds. */
const NUMERIC_APPLIED_KEYS = [
  'max_concurrent_users',
  'max_events_per_second',
  'max_bytes_per_second',
  'max_channels_per_client',
  'max_joins_per_second',
  'max_presence_events_per_second',
  'max_payload_size_in_kb',
] as const

const BOOLEAN_APPLIED_KEYS = ['private_only', 'suspend'] as const

type NumericAppliedKey = (typeof NUMERIC_APPLIED_KEYS)[number]
type BooleanAppliedKey = (typeof BOOLEAN_APPLIED_KEYS)[number]

/**
 * Settings the platform's contract carries that Realtime has no column for.
 *
 * They are kept in the state file and answered from it, so the form round-trips the value the
 * operator typed, and they are never sent to Realtime: `connection_pool` and
 * `postgres_changes_pool` size pools the platform manages outside the tenant record, and
 * `presence_enabled` has no counterpart in `Realtime.Api.Tenant` at all. Their self-hosted mapping
 * is unconfirmed, and inventing one would write a column that does not exist.
 */
const NUMERIC_STORED_ONLY_KEYS = ['connection_pool', 'postgres_changes_pool'] as const
const BOOLEAN_STORED_ONLY_KEYS = ['presence_enabled'] as const

type NumericStoredOnlyKey = (typeof NUMERIC_STORED_ONLY_KEYS)[number]
type BooleanStoredOnlyKey = (typeof BOOLEAN_STORED_ONLY_KEYS)[number]

/**
 * The largest value each setting may take. The first four are the ceilings the settings form
 * itself enforces (`REALTIME_SOFT_LIMITS` in `RealtimeSettings.tsx`); the rest are a sanity bound,
 * because Realtime's own changeset validates none of them and a mistyped number would otherwise be
 * written straight into the tenant. The floor is 1 everywhere: zero is not "unlimited" to Realtime,
 * it is a rate limit of nothing.
 */
const NUMERIC_LIMITS = {
  max_concurrent_users: 300_000,
  max_events_per_second: 50_000,
  max_presence_events_per_second: 5_000,
  max_payload_size_in_kb: 3_000,
  max_bytes_per_second: 1_000_000,
  max_channels_per_client: 1_000_000,
  max_joins_per_second: 1_000_000,
  connection_pool: 1_000_000,
  postgres_changes_pool: 1_000_000,
} as const satisfies Record<NumericAppliedKey | NumericStoredOnlyKey, number>

/**
 * What a freshly seeded tenant is actually running, for the four columns the view will not report.
 * Taken from `Realtime.Api.Tenant`'s schema defaults (`max_presence_events_per_second: 1000`,
 * `max_payload_size_in_kb: 3000`, `suspend: false`) and from `config/runtime.exs`, where
 * `maybe_set_default` sources the rest (`TENANT_MAX_*`, defaulting to 100_000 / 100 / 200 / 100 /
 * 100).
 *
 * Deliberately **not** the UI's `REALTIME_DEFAULT_CONFIG`, which assumes 100 for presence events
 * and 100 KB for the payload. Showing those would misreport a stock install by a factor of ten and
 * thirty, and the form posts back what it was shown — so the first unrelated save would quietly cut
 * both limits.
 */
const NUMERIC_DEFAULTS = {
  max_concurrent_users: 200,
  max_events_per_second: 100,
  max_bytes_per_second: 100_000,
  max_channels_per_client: 100,
  max_joins_per_second: 100,
  max_presence_events_per_second: 1000,
  max_payload_size_in_kb: 3000,
} as const satisfies Record<NumericAppliedKey, number>

const BOOLEAN_DEFAULTS = {
  private_only: false,
  suspend: false,
} as const satisfies Record<BooleanAppliedKey, boolean>

/** What the settings form assumes for the three Realtime does not hold. */
const NUMERIC_STORED_ONLY_DEFAULTS = {
  connection_pool: 2,
  postgres_changes_pool: 2,
} as const satisfies Record<NumericStoredOnlyKey, number>

const BOOLEAN_STORED_ONLY_DEFAULTS = {
  presence_enabled: true,
} as const satisfies Record<BooleanStoredOnlyKey, boolean>

type Tenant = Record<string, unknown>

const asRecord = (value: unknown): Tenant | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Tenant)
    : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

/**
 * The tenant as Realtime's HTTP API reports it, which is the fallback read and the only place a
 * missing tenant is reported from. `TenantView` wraps it as `{ data: … }`.
 *
 * A 200 that carries no tenant is a {@link ServiceUnavailableError} rather than a 500, the way the
 * pooler's is: `REALTIME_TENANT_ID` naming a tenant Realtime does not have is the operator's own
 * misconfiguration, and that is what they need told.
 */
async function getTenant(): Promise<Tenant> {
  const body = await adminFetch(tenantUrl(), { method: 'GET', token: token() })
  const tenant = asRecord(asRecord(body)?.data)

  if (!tenant) {
    throw new ServiceUnavailableError(`Realtime returned no tenant for ${realtimeTenantId()}`)
  }

  return tenant
}

/**
 * One line to the server log. Studio has no logger module of its own; server-side `lib` code writes
 * to the console (`lib/upload.ts`, `lib/server/configcat.ts`, `lib/integration-utils.ts`). These
 * warnings are the only way an operator learns that this settings page is answering in a degraded
 * mode. A tenant id and a service's own error text are infrastructure, not anyone's data.
 */
const warn = (message: string): void => console.warn(`[realtime-config] ${message}`)

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * A tenant id worth sending. The id travels as a bound parameter, so this is not about escaping — it
 * is a sanity bound, so that something no tenant name could be is refused before it turns into a
 * puzzling empty read.
 *
 * In practice only the length half can fire: `realtimeTenantId()` already falls back to
 * `realtime-dev` on an empty environment value, so the emptiness check guards this function's own
 * contract rather than anything an operator can set. 255 is generous for a value Realtime keeps in
 * one column; every real tenant name is a fraction of it.
 */
const MAX_TENANT_ID_LENGTH = 255

const isUsableTenantId = (tenantId: string): boolean =>
  tenantId.length > 0 && tenantId.length <= MAX_TENANT_ID_LENGTH

/** The nine columns, in one place, so the query cannot drift from the keys it is read into. */
const APPLIED_COLUMNS = [...NUMERIC_APPLIED_KEYS, ...BOOLEAN_APPLIED_KEYS]

const TENANT_ROW_QUERY = `select ${APPLIED_COLUMNS.join(', ')} from _realtime.tenants where external_id = $1`

/**
 * The tenant row as Realtime's own database holds it — all nine columns, including the four its HTTP
 * view will not serialise.
 *
 * Read on the read-write connection (`POSTGRES_USER_READ_WRITE`, a superuser) rather than the
 * read-only one, because `_realtime` is Realtime's schema and the read-only role is not granted on
 * it. Nothing here writes; the connection is only what can see the table.
 *
 * The tenant id is sent as a bound parameter rather than as text in the query, so a name carrying a
 * quote or a semicolon is a name, not a fragment of SQL, and `dev_tenant`-style ids work unchanged.
 *
 * Every failure reads as "the table could not be answered from" and hands over to the admin API:
 * a schema that is not there because Realtime runs on its own database, a role that cannot see it,
 * a tenant id that is empty or absurdly long, or no row at all. A column that comes back as the
 * wrong shape — or as `null`, which Realtime allows before `maybe_set_default` fills it — is left
 * out of the result rather than guessed at, so it reads as unverifiable and gets re-applied.
 */
async function readTenantFromDatabase(): Promise<Tenant | undefined> {
  const tenantId = realtimeTenantId()
  if (!isUsableTenantId(tenantId)) return undefined

  let rows: unknown
  try {
    const { data, error } = await executeQuery<Record<string, unknown>>({
      query: TENANT_ROW_QUERY,
      parameters: [tenantId],
    })
    if (error) return undefined
    rows = data
  } catch {
    return undefined
  }

  const row = asRecord(Array.isArray(rows) ? rows[0] : undefined)
  if (!row) return undefined

  const tenant: Tenant = {}
  for (const key of NUMERIC_APPLIED_KEYS) {
    const value = asNumber(row[key])
    if (value !== undefined) tenant[key] = value
  }
  for (const key of BOOLEAN_APPLIED_KEYS) {
    const value = asBoolean(row[key])
    if (value !== undefined) tenant[key] = value
  }

  return tenant
}

/**
 * The tenant as it actually stands: from its own row where that can be read, else from the API.
 *
 * The fallback is warned about every time, because it is not a neutral substitution — the API
 * reports five of the nine columns, so four of them stop being verifiable and get re-applied on
 * every read. Nothing in the UI shows that, and an operator wondering why their Realtime settings
 * are written back constantly has nowhere else to look.
 */
const getLiveTenant = async (): Promise<Tenant> => {
  const row = await readTenantFromDatabase()
  if (row) return row

  warn(
    `could not read _realtime.tenants for ${realtimeTenantId()}, falling back to Realtime's admin ` +
      'API, which does not report max_bytes_per_second, max_presence_events_per_second, ' +
      'max_payload_size_in_kb or suspend'
  )

  return await getTenant()
}

/**
 * Writes the named columns, and only those.
 *
 * `extensions` is never sent. `has_many :extensions` is declared `on_replace: :delete`, and the
 * changeset ends in `cast_assoc(:extensions, …)`, so an `extensions` key in the body replaces the
 * whole set — and the tenant's one extension is the Postgres CDC connection every
 * `postgres_changes` subscription runs through. Leaving the key out leaves the association alone.
 *
 * `external_id` is not sent either: `validate_required([:external_id])` reads through to the row
 * that already has one, and the URL already says which tenant this is.
 */
async function putTenant(tenant: Record<string, number | boolean>): Promise<void> {
  await adminFetch(tenantUrl(), {
    method: 'PUT',
    token: token(),
    body: JSON.stringify({ tenant }),
  })
}

/**
 * The settings that were saved, in the shape a `PUT` takes, dropping anything the state file holds
 * in the wrong shape — the file is Studio's own, but a hand-edited one should not become a request.
 */
function appliedFromState(state: Record<string, unknown>): Record<string, number | boolean> {
  const applied: Record<string, number | boolean> = {}

  for (const key of NUMERIC_APPLIED_KEYS) {
    const value = asNumber(state[key])
    if (value !== undefined) applied[key] = value
  }
  for (const key of BOOLEAN_APPLIED_KEYS) {
    const value = asBoolean(state[key])
    if (value !== undefined) applied[key] = value
  }

  return applied
}

/**
 * Whether the tenant has to be written back before its settings can be reported.
 *
 * A saved setting the live read reports is compared exactly, so a tenant that already matches is
 * left alone. A saved setting the live read cannot report at all is treated as drifted, because
 * there is nothing to compare it with and the seeds reset it on every restart. Reading the tenant
 * row reports all nine, so that second branch is the admin-API fallback's — see the note at the top
 * of this file.
 */
const hasDrifted = (applied: Record<string, number | boolean>, live: Tenant): boolean =>
  Object.entries(applied).some(([key, value]) => !(key in live) || live[key] !== value)

export async function getRealtimeConfig(): Promise<RealtimeConfig> {
  const state = await readJsonState(REALTIME_STATE_FILE_NAME)
  const live = await getLiveTenant()
  const applied = appliedFromState(state)

  // A read does not fail over a write. If the reconcile cannot land, the page still answers — with
  // the values the operator asked for, which is what the form should show them — and the next read
  // tries again. Only a `PATCH` reports a write that did not happen, because there somebody is
  // waiting to hear whether their save took.
  const reconciled = hasDrifted(applied, live)
  if (reconciled) {
    try {
      await putTenant(applied)
    } catch (error) {
      warn(`could not re-apply the saved Realtime settings: ${describeError(error)}`)
    }
  }

  // After a reconcile the saved value is the one Realtime is running, so it wins; otherwise the
  // tenant is the record and the saved value is only a fallback for what the view will not report.
  const number = (key: NumericAppliedKey): number => {
    const saved = asNumber(state[key])
    const running = asNumber(live[key])
    return (reconciled ? (saved ?? running) : (running ?? saved)) ?? NUMERIC_DEFAULTS[key]
  }

  const boolean = (key: BooleanAppliedKey): boolean => {
    const saved = asBoolean(state[key])
    const running = asBoolean(live[key])
    return (reconciled ? (saved ?? running) : (running ?? saved)) ?? BOOLEAN_DEFAULTS[key]
  }

  return {
    max_concurrent_users: number('max_concurrent_users'),
    max_events_per_second: number('max_events_per_second'),
    max_bytes_per_second: number('max_bytes_per_second'),
    max_channels_per_client: number('max_channels_per_client'),
    max_joins_per_second: number('max_joins_per_second'),
    max_presence_events_per_second: number('max_presence_events_per_second'),
    max_payload_size_in_kb: number('max_payload_size_in_kb'),
    private_only: boolean('private_only'),
    suspend: boolean('suspend'),
    connection_pool:
      asNumber(state.connection_pool) ?? NUMERIC_STORED_ONLY_DEFAULTS.connection_pool,
    postgres_changes_pool:
      asNumber(state.postgres_changes_pool) ?? NUMERIC_STORED_ONLY_DEFAULTS.postgres_changes_pool,
    presence_enabled:
      asBoolean(state.presence_enabled) ?? BOOLEAN_STORED_ONLY_DEFAULTS.presence_enabled,
    // A platform admin's suspension of the project. Self-hosted there is no admin to suspend it.
    admin_suspended_at: null,
  }
}

const isNumericKey = (key: string): key is keyof typeof NUMERIC_LIMITS => key in NUMERIC_LIMITS

const BOOLEAN_KEYS: readonly string[] = [...BOOLEAN_APPLIED_KEYS, ...BOOLEAN_STORED_ONLY_KEYS]

/**
 * The patch, checked against what each setting may hold.
 *
 * A key the page does not own is refused rather than ignored: the body reaches the tenant
 * changeset, which casts `jwt_secret`, `jwt_jwks`, `external_id` and `migrations_ran` among others,
 * and a settings form is not the place any of those may be set from.
 *
 * `undefined` and `null` read as "leave this one alone" — the form sends the whole body on every
 * save and a cleared number input arrives as `null` — but only after the key itself has been
 * recognised, so a misspelling is still a 400 rather than a silent no-op.
 */
function validatePatch(body: UpdateRealtimeConfigBody): Record<string, number | boolean> {
  // The body is parsed JSON from a request, so it is read as unknown rather than trusted as typed.
  const fields = { ...body } as Record<string, unknown>
  const patch: Record<string, number | boolean> = {}

  for (const [key, value] of Object.entries(fields)) {
    const numeric = isNumericKey(key)

    if (!numeric && !BOOLEAN_KEYS.includes(key)) {
      throw new ServiceConfigValidationError(`${key} is not a Realtime setting`)
    }

    if (value === undefined || value === null) continue

    if (numeric) {
      const max = NUMERIC_LIMITS[key]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
        throw new ServiceConfigValidationError(`${key} must be an integer between 1 and ${max}`)
      }
      patch[key] = value
    } else {
      if (typeof value !== 'boolean') {
        throw new ServiceConfigValidationError(`${key} must be true or false`)
      }
      patch[key] = value
    }
  }

  return patch
}

/**
 * Saves the settings and applies them.
 *
 * The record is written before the tenant, on purpose: if the `PUT` fails, the settings page still
 * knows what the operator asked for and the next read re-applies it, rather than the request
 * vanishing with the error.
 *
 * The whole saved set is sent, not just this patch, because a `PUT` that names one column leaves
 * the others wherever the last restart's seeds put them.
 *
 * Answers nothing: the platform's `PATCH` is a 204, and the settings page refetches.
 */
export async function updateRealtimeConfig(body: UpdateRealtimeConfigBody): Promise<void> {
  const patch = validatePatch(body)

  const state = await readJsonState(REALTIME_STATE_FILE_NAME)
  const next = { ...state, ...patch }
  await writeJsonState(REALTIME_STATE_FILE_NAME, next)

  const applied = appliedFromState(next)
  if (Object.keys(applied).length === 0) return

  await putTenant(applied)
}
