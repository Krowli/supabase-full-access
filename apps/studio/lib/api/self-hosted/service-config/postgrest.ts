import { components } from 'api-types'

import { DEFAULT_AUTH_JWT_SECRET, DEFAULT_EXPOSED_SCHEMAS, POSTGRES_DATABASE } from '../constants'
import { isMultiProject, projectEnv, projectPostgres } from '../project-context'
import { executeQuery } from '../query'
import { ServiceConfigValidationError } from './errors'

type GetPostgrestConfigResponse = components['schemas']['GetPostgrestConfigResponse_Output']
type UpdatePostgrestConfigBody = components['schemas']['UpdatePostgrestConfigBody']
type UpdatePostgrestConfigResponse = components['schemas']['UpdatePostgrestConfigResponse_Output']

/** `db_pool` is part of the platform's answer but missing from the generated type. */
export type PostgrestConfig = GetPostgrestConfigResponse & { db_pool: number | null }

/**
 * `UpdatePostgrestConfigBody`, widened to the `db_pool: null` a client sends for a cleared field.
 * Both pool fields are accepted and then ignored — see the note below — so the type exists to let a
 * body carrying them through without a cast, not because either one is written.
 */
export type UpdatePostgrestConfigInput = Omit<UpdatePostgrestConfigBody, 'db_pool'> & {
  db_pool?: number | null
}

/**
 * PostgREST's in-database configuration: settings on the `authenticator` role, which override the
 * container env the service was started with. Reading them back is how Studio can answer with what
 * PostgREST is running on rather than with what the compose file once said.
 *
 * `setconfig` is a `text[]` of `name=value`, one array per (role, database) pair. A role can be
 * configured globally (`setdatabase = 0`) and again for one database, and the database-scoped row is
 * the one that applies where both exist. Both rows are read and the scoped one wins, so what Studio
 * answers with is what PostgREST resolves on the database it is connected to. Rows for any *other*
 * database are excluded in SQL — they describe a connection this stack does not make.
 *
 * The three settings this module writes are in-database settings and reload without a restart:
 * `db-schemas`, `db-extra-search-path` and `db-max-rows`. **`db-pool` and
 * `db-pool-acquisition-timeout` are neither** — the PostgREST 14 reference gives both "In-Database:
 * n/a" and "Reloadable: N", so a `pgrst.db_pool` on the role would be a GUC nothing reads, and the
 * pool size can only be changed by the container's `PGRST_DB_POOL` plus a restart. Rather than
 * store a number that would read back as if it had taken effect, this module never writes either
 * one and answers `null` for both. The UI keeps the field read-only self-hosted and says where the
 * real value lives.
 * See https://docs.postgrest.org/en/v14/references/configuration.html#db-pool.
 */
const ROLE_SETTINGS_QUERY = `select s.setdatabase, unnest(s.setconfig) as setting
from pg_catalog.pg_db_role_setting s
join pg_catalog.pg_roles r on r.oid = s.setrole
where r.rolname = 'authenticator'
  and (
    s.setdatabase = 0
    or s.setdatabase = (select oid from pg_database where datname = current_database())
  )`

type RoleSettingRow = { setdatabase?: unknown; setting?: unknown }

/**
 * The schemas PostgREST was started with: the container's `PGRST_DB_SCHEMAS`, or with a project
 * registry, this request's project's. Each project's PostgREST has its own.
 */
const startedWithSchemas = () =>
  isMultiProject()
    ? (projectEnv('PGRST_DB_SCHEMAS') ?? 'public,graphql_public')
    : DEFAULT_EXPOSED_SCHEMAS

/** A Postgres schema name, and the length Postgres truncates identifiers at. */
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/
const MAX_IDENTIFIER_LENGTH = 63

/**
 * A database name safe to quote into `IN DATABASE "…"`. Narrower than Postgres allows — a quoted
 * identifier may hold almost anything — because this one comes from the container's `POSTGRES_DB`
 * and is interpolated, not bound. A name outside this shape is a misconfiguration to report, not
 * something to escape.
 */
const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Strips the one layer of double quotes Postgres adds around a setting value that holds a comma,
 * so `pgrst.db_schemas="public, graphql_public"` reads back as the list that was written.
 */
function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value
}

/** `setdatabase = 0` is the row that applies to every database; anything else is scoped to one. */
const isGlobalRow = (setdatabase: unknown) => setdatabase === 0 || setdatabase === '0'

/**
 * The settings as Postgres would resolve them for the current database: the global rows first, then
 * the database-scoped ones written over them. Built in two passes rather than one so the winner
 * does not depend on the order the rows came back in.
 */
function parseRoleSettings(rows: readonly RoleSettingRow[]): Map<string, string> {
  const global = new Map<string, string>()
  const scoped = new Map<string, string>()

  for (const row of rows) {
    const setting = row?.setting
    if (typeof setting !== 'string') continue

    const separator = setting.indexOf('=')
    if (separator === -1) continue

    const target = isGlobalRow(row?.setdatabase) ? global : scoped
    target.set(setting.slice(0, separator), unquote(setting.slice(separator + 1)))
  }

  return new Map([...global, ...scoped])
}

/**
 * A setting Postgres holds as text, read back as a number. Anything that is not an integer — a
 * value someone set by hand, or a unit suffix — falls back to the env value rather than to `NaN`.
 */
function parseInteger(value: string | undefined): number | null {
  if (value === undefined) return null

  const trimmed = value.trim()
  if (!/^-?\d+$/.test(trimmed)) return null

  return Number(trimmed)
}

/**
 * The Data API settings as PostgREST would resolve them: a role setting where one is set, and the
 * env the container was started with everywhere else.
 */
export async function getPostgrestConfig(): Promise<PostgrestConfig> {
  const { data, error } = await executeQuery<RoleSettingRow>({ query: ROLE_SETTINGS_QUERY })
  if (error) throw error

  const settings = parseRoleSettings(data ?? [])

  return {
    db_anon_role: 'anon',
    db_extra_search_path:
      settings.get('pgrst.db_extra_search_path') ??
      projectEnv('PGRST_DB_EXTRA_SEARCH_PATH') ??
      'public',
    // Not an in-database setting, so there is nothing here to read it from. `null` is what the
    // platform answers when the pool is not pinned, and what the UI renders as "set elsewhere".
    db_pool: null,
    db_schema: settings.get('pgrst.db_schemas') ?? startedWithSchemas(),
    jwt_secret: projectEnv('AUTH_JWT_SECRET') ?? DEFAULT_AUTH_JWT_SECRET,
    max_rows:
      parseInteger(settings.get('pgrst.db_max_rows')) ??
      (Number(projectEnv('PGRST_DB_MAX_ROWS')) || 1000),
    role_claim_key: '.role',
  }
}

/** The names of a comma-separated list, with nothing between them but the comma. */
function joinSchemaNames(list: string): string {
  return list
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .join(',')
}

/**
 * The schemas the Data API exposes, for the callers that only need that one field: the MCP
 * advisors, the type generator and the lint runner. They used to read `PGRST_DB_SCHEMAS` from the
 * container env at import time, which stopped being the answer the moment the settings page could
 * change it.
 *
 * The list comes back without the spaces the stored setting carries. A save writes
 * `pgrst.db_schemas` as `public, graphql_public` — the spaced form {@link validateSchemaList} joins,
 * which is what the settings page renders and what `getPostgrestConfig().db_schema` keeps — but
 * every caller here puts the list somewhere a space is not a separator: the type generator
 * interpolates it into `included_schemas=` on the pg-meta URL, and the advisors take it as a list of
 * names. ` graphql_public` with the space still on it is a schema none of them match.
 *
 * A database that cannot be reached falls back to the env rather than failing the caller. Every one
 * of them is doing something else — generating types, running lints — and the env value is what
 * they would have used before; refusing to run at all would be a worse answer than a stale schema
 * list.
 */
export async function getExposedSchemas(): Promise<string> {
  try {
    return joinSchemaNames((await getPostgrestConfig()).db_schema)
  } catch {
    return joinSchemaNames(startedWithSchemas())
  }
}

/**
 * A comma-separated list of schema names, normalised to the names themselves. Every name is checked
 * against {@link SCHEMA_NAME} because the result is interpolated into SQL — a name that passes
 * cannot carry a quote, a semicolon or a space, so there is nothing left in it to escape.
 */
function validateSchemaList(
  value: unknown,
  field: string,
  { allowEmpty }: { allowEmpty: boolean }
): string {
  if (typeof value !== 'string') {
    throw new ServiceConfigValidationError(
      `${field} must be a comma-separated list of schema names`
    )
  }

  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')

  if (names.length === 0) {
    if (allowEmpty) return ''
    throw new ServiceConfigValidationError(`${field} must name at least one schema`)
  }

  for (const name of names) {
    if (!SCHEMA_NAME.test(name) || name.length > MAX_IDENTIFIER_LENGTH) {
      throw new ServiceConfigValidationError(`${field} is not a valid schema name: ${name}`)
    }
  }

  return names.join(', ')
}

function validateInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ServiceConfigValidationError(`${field} must be an integer between ${min} and ${max}`)
  }

  return value
}

/**
 * The database the write is scoped to. A global `ALTER ROLE ... SET` would be shadowed by any
 * database-scoped setting already on the role, so a save could appear to work and change nothing.
 * Writing where PostgREST reads keeps the write and the read on the same row.
 */
function databaseName(): string {
  const database = isMultiProject() ? projectPostgres().database : POSTGRES_DATABASE
  if (!DATABASE_NAME.test(database) || database.length > MAX_IDENTIFIER_LENGTH) {
    // Not a `ServiceConfigValidationError`: nothing the client sent is wrong. The container's
    // POSTGRES_DB is, and that is a 500 the operator needs to see.
    throw new Error(`POSTGRES_DB is not a name this can scope a setting to: ${database}`)
  }

  return database
}

/** Safe to quote rather than escape: every value reaching here passed the validation above. */
const setSetting = (database: string, name: string, value: string) =>
  `ALTER ROLE authenticator IN DATABASE "${database}" SET pgrst.${name} = '${value}';`

/** The two fields of the platform's body that the database cannot hold. See the note above. */
const IGNORED_KEYS = ['db_pool', 'db_pool_acquisition_timeout'] as const

/**
 * Writes the settings PostgREST reads from the database and tells it to pick them up.
 *
 * Only the fields the body carries are written — a PATCH names what changed, and resetting the rest
 * to their env values would undo settings the operator never touched.
 *
 * The two pool fields are dropped before anything else happens. Neither is an in-database setting,
 * so writing one would store a number PostgREST never reads and then hand it back on the next GET
 * as though the pool had changed. A body carrying them is not an error — the platform's contract
 * has both, and a client saving the whole form sends what it was given — it just does not move
 * them.
 */
export async function updatePostgrestConfig(
  body: UpdatePostgrestConfigInput
): Promise<UpdatePostgrestConfigResponse> {
  // The body is parsed JSON from a request, so it is read as unknown rather than trusted as typed.
  const fields = { ...body } as Record<string, unknown>
  for (const key of IGNORED_KEYS) delete fields[key]

  const database = databaseName()
  const statements: string[] = []

  if (fields.db_schema !== undefined) {
    const schemas = validateSchemaList(fields.db_schema, 'db_schema', { allowEmpty: false })
    statements.push(setSetting(database, 'db_schemas', schemas))
  }

  if (fields.db_extra_search_path !== undefined) {
    const searchPath = validateSchemaList(fields.db_extra_search_path, 'db_extra_search_path', {
      allowEmpty: true,
    })
    statements.push(setSetting(database, 'db_extra_search_path', searchPath))
  }

  if (fields.max_rows !== undefined) {
    const maxRows = validateInteger(fields.max_rows, 'max_rows', 1, 1_000_000)
    statements.push(setSetting(database, 'db_max_rows', String(maxRows)))
  }

  // Both channels. Changing `db-schemas` changes which tables and functions PostgREST serves, and
  // that lives in the schema cache rather than in the config — the docs give the two as separate
  // notifications, and note that a schema reload also reloads the in-database configuration. So
  // the pair is right whichever field moved, and costs nothing when neither needed it. Sent even
  // for a PATCH that changed nothing, which keeps every request on one path.
  statements.push(`NOTIFY pgrst, 'reload config';`)
  statements.push(`NOTIFY pgrst, 'reload schema';`)

  const { error } = await executeQuery({ query: statements.join('\n') })
  if (error) throw error

  const config = await getPostgrestConfig()

  return {
    db_extra_search_path: config.db_extra_search_path,
    db_pool: config.db_pool,
    db_pool_acquisition_timeout: null,
    db_schema: config.db_schema,
    max_rows: config.max_rows,
  }
}
