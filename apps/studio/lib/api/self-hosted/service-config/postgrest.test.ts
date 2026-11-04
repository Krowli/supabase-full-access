import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AUTH_JWT_SECRET, DEFAULT_EXPOSED_SCHEMAS, POSTGRES_DATABASE } from '../constants'
import { ServiceConfigValidationError } from './errors'
import { getExposedSchemas, getPostgrestConfig, updatePostgrestConfig } from './postgrest'

const { executeQuery } = vi.hoisted(() => ({ executeQuery: vi.fn() }))
vi.mock('../query', () => ({ executeQuery }))

/** The oid of a database-scoped row. Any non-zero `setdatabase` names one database. */
const THIS_DATABASE = 16384

/**
 * The role settings the next read sees, as `pg_db_role_setting` hands them over. Typed loosely
 * because that is how they arrive: an oid may reach JavaScript as a number or as a string.
 */
const withRows = (...rows: { setdatabase: unknown; setting: unknown }[]) => {
  executeQuery.mockResolvedValue({ data: rows, error: undefined })
}

/** Settings written with a plain `ALTER ROLE`, which apply to every database. */
const withRoleSettings = (...settings: string[]) =>
  withRows(...settings.map((setting) => ({ setdatabase: 0, setting })))

/** Settings written with `ALTER ROLE ... IN DATABASE`, which apply to this one. */
const withDatabaseSettings = (...settings: string[]) =>
  withRows(...settings.map((setting) => ({ setdatabase: THIS_DATABASE, setting })))

/** The SQL of the call that wrote, which is always the first of the two an update makes. */
const writtenSql = (): string => executeQuery.mock.calls[0][0].query

describe('api/self-hosted/service-config/postgrest', () => {
  beforeEach(() => {
    executeQuery.mockReset()
    withRoleSettings()
    vi.unstubAllEnvs()
    // Cleared so a variable in the ambient environment cannot decide what a fallback answers with.
    vi.stubEnv('PGRST_DB_EXTRA_SEARCH_PATH', undefined)
    vi.stubEnv('PGRST_DB_MAX_ROWS', undefined)
    vi.stubEnv('AUTH_JWT_SECRET', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('getPostgrestConfig', () => {
    it('asks for the settings of the authenticator role', async () => {
      await getPostgrestConfig()

      expect(executeQuery).toHaveBeenCalledTimes(1)
      expect(writtenSql()).toContain('pg_catalog.pg_db_role_setting')
      expect(writtenSql()).toContain("r.rolname = 'authenticator'")
    })

    it('asks only for rows that apply to the database it is connected to', async () => {
      // A row scoped to some other database describes a connection this stack does not make.
      await getPostgrestConfig()

      expect(writtenSql()).toContain('s.setdatabase')
      expect(writtenSql()).toContain('s.setdatabase = 0')
      expect(writtenSql()).toContain(
        's.setdatabase = (select oid from pg_database where datname = current_database())'
      )
    })

    it('lets a database-scoped setting win over the global one', async () => {
      // Postgres resolves the scoped row last, so a global setting left over from an earlier
      // install must not be the answer once this database has one of its own.
      withRows(
        { setdatabase: 0, setting: 'pgrst.db_schemas=public' },
        { setdatabase: THIS_DATABASE, setting: 'pgrst.db_schemas=public,api' }
      )

      await expect(getPostgrestConfig()).resolves.toMatchObject({ db_schema: 'public,api' })
    })

    it('lets the scoped setting win whichever order the rows arrive in', async () => {
      withRows(
        { setdatabase: THIS_DATABASE, setting: 'pgrst.db_schemas=public,api' },
        { setdatabase: 0, setting: 'pgrst.db_schemas=public' }
      )

      await expect(getPostgrestConfig()).resolves.toMatchObject({ db_schema: 'public,api' })
    })

    it('falls back to the global setting for a field the scoped row does not carry', async () => {
      withRows(
        { setdatabase: 0, setting: 'pgrst.db_max_rows=500' },
        { setdatabase: THIS_DATABASE, setting: 'pgrst.db_schemas=public,api' }
      )

      await expect(getPostgrestConfig()).resolves.toMatchObject({
        db_schema: 'public,api',
        max_rows: 500,
      })
    })

    it('reads the oids whether they arrive as numbers or as strings', async () => {
      // Whether an oid comes back as a number or a string is the driver's business, not this
      // code's, and mistaking a global row for a scoped one would invert which setting wins.
      withRows(
        { setdatabase: '0', setting: 'pgrst.db_schemas=public' },
        { setdatabase: '16384', setting: 'pgrst.db_schemas=public,api' }
      )

      await expect(getPostgrestConfig()).resolves.toMatchObject({ db_schema: 'public,api' })
    })

    it('reads the role settings PostgREST runs on', async () => {
      withRoleSettings(
        'pgrst.db_schemas=public,graphql_public,api',
        'pgrst.db_extra_search_path=public,extensions',
        'pgrst.db_max_rows=500'
      )

      await expect(getPostgrestConfig()).resolves.toMatchObject({
        db_schema: 'public,graphql_public,api',
        db_extra_search_path: 'public,extensions',
        max_rows: 500,
      })
    })

    it('answers null for the pool even when the role carries a setting for it', async () => {
      // PostgREST does not read `pgrst.db_pool` from the database, so a value found there would
      // describe nothing. One could only be left over from a hand-written ALTER ROLE.
      withRoleSettings('pgrst.db_pool=25')

      await expect(getPostgrestConfig()).resolves.toMatchObject({ db_pool: null })
    })

    it('strips the quotes Postgres puts around a value holding a comma', async () => {
      withRoleSettings(
        'pgrst.db_schemas="public, graphql_public"',
        'pgrst.db_extra_search_path="public, extensions"'
      )

      await expect(getPostgrestConfig()).resolves.toMatchObject({
        db_schema: 'public, graphql_public',
        db_extra_search_path: 'public, extensions',
      })
    })

    it('keeps a value that itself contains an equals sign', async () => {
      withRoleSettings('pgrst.db_extra_search_path=a=b')

      await expect(getPostgrestConfig()).resolves.toMatchObject({ db_extra_search_path: 'a=b' })
    })

    it('ignores settings of other extensions and rows without a value', async () => {
      withRoleSettings('statement_timeout=8s', 'search_path', 'pgrst.db_max_rows=42')

      await expect(getPostgrestConfig()).resolves.toMatchObject({ max_rows: 42 })
    })

    it('falls back to the container env when nothing is set on the role', async () => {
      vi.stubEnv('PGRST_DB_EXTRA_SEARCH_PATH', 'public,extensions')
      vi.stubEnv('PGRST_DB_MAX_ROWS', '750')

      await expect(getPostgrestConfig()).resolves.toEqual({
        db_anon_role: 'anon',
        db_extra_search_path: 'public,extensions',
        db_pool: null,
        db_schema: DEFAULT_EXPOSED_SCHEMAS,
        jwt_secret: DEFAULT_AUTH_JWT_SECRET,
        max_rows: 750,
        role_claim_key: '.role',
      })
    })

    it('falls back to the built-in defaults when the env is empty too', async () => {
      await expect(getPostgrestConfig()).resolves.toMatchObject({
        db_extra_search_path: 'public',
        max_rows: 1000,
        db_pool: null,
      })
    })

    it('falls back to the env when a role setting is not an integer', async () => {
      vi.stubEnv('PGRST_DB_MAX_ROWS', '750')
      withRoleSettings('pgrst.db_max_rows=lots')

      await expect(getPostgrestConfig()).resolves.toMatchObject({ max_rows: 750 })
    })

    it('answers with the JWT secret the stack was started with', async () => {
      vi.stubEnv('AUTH_JWT_SECRET', 'a-secret-of-at-least-32-characters-long')

      await expect(getPostgrestConfig()).resolves.toMatchObject({
        jwt_secret: 'a-secret-of-at-least-32-characters-long',
      })
    })

    it('surfaces a database error rather than answering with the env', async () => {
      executeQuery.mockResolvedValue({ data: undefined, error: new Error('connection refused') })

      await expect(getPostgrestConfig()).rejects.toThrow('connection refused')
    })
  })

  describe('updatePostgrestConfig', () => {
    it('writes every field the database can hold, then tells PostgREST to reload', async () => {
      await updatePostgrestConfig({
        db_schema: 'public,graphql_public',
        db_extra_search_path: 'public,extensions',
        max_rows: 500,
        db_pool: 25,
        db_pool_acquisition_timeout: 10,
      })

      expect(writtenSql()).toBe(
        [
          `ALTER ROLE authenticator IN DATABASE "${POSTGRES_DATABASE}" SET pgrst.db_schemas = 'public, graphql_public';`,
          `ALTER ROLE authenticator IN DATABASE "${POSTGRES_DATABASE}" SET pgrst.db_extra_search_path = 'public, extensions';`,
          `ALTER ROLE authenticator IN DATABASE "${POSTGRES_DATABASE}" SET pgrst.db_max_rows = '500';`,
          `NOTIFY pgrst, 'reload config';`,
          `NOTIFY pgrst, 'reload schema';`,
        ].join('\n')
      )
    })

    it('sends the whole change as one statement, and reads back after it', async () => {
      await updatePostgrestConfig({ max_rows: 500 })

      expect(executeQuery).toHaveBeenCalledTimes(2)
      expect(writtenSql().endsWith(`NOTIFY pgrst, 'reload schema';`)).toBe(true)
    })

    it('scopes the write to the database PostgREST is connected to', async () => {
      // A global `ALTER ROLE ... SET` is shadowed by any database-scoped row already on the role,
      // so a save would appear to work and change nothing. Write where the read looks.
      await updatePostgrestConfig({ max_rows: 500 })

      expect(writtenSql()).toContain(`IN DATABASE "${POSTGRES_DATABASE}"`)
      expect(writtenSql()).not.toContain('ALTER ROLE authenticator SET')
    })

    it('reloads the schema cache too, since the exposed schemas may have moved', async () => {
      // Which tables and functions PostgREST serves lives in the schema cache rather than in the
      // config, so a schema newly named in `db-schemas` is not served until the cache is rebuilt.
      await updatePostgrestConfig({ db_schema: 'public,api' })

      expect(writtenSql()).toBe(
        [
          `ALTER ROLE authenticator IN DATABASE "${POSTGRES_DATABASE}" SET pgrst.db_schemas = 'public, api';`,
          `NOTIFY pgrst, 'reload config';`,
          `NOTIFY pgrst, 'reload schema';`,
        ].join('\n')
      )
    })

    it('leaves the fields the body does not name alone', async () => {
      await updatePostgrestConfig({ max_rows: 500 })

      expect(writtenSql()).toBe(
        [
          `ALTER ROLE authenticator IN DATABASE "${POSTGRES_DATABASE}" SET pgrst.db_max_rows = '500';`,
          `NOTIFY pgrst, 'reload config';`,
          `NOTIFY pgrst, 'reload schema';`,
        ].join('\n')
      )
    })

    it.each([
      ['a pool size', { db_pool: 25 }],
      ['a cleared pool size', { db_pool: null }],
      ['an acquisition timeout', { db_pool_acquisition_timeout: 10 }],
      ['an idle time', { db_pool_max_idletime: 60 }],
      ['a lifetime', { db_pool_max_lifetime: 3600 }],
      ['a pool size out of the range the form allows', { db_pool: 99999 }],
    ] as const)('never touches pgrst.db_pool, given %s', async (_name, body) => {
      // None is an in-database setting, so a value written here would be a number PostgREST
      // never reads and the next GET would hand it back as though the pool had changed.
      await updatePostgrestConfig(body)

      expect(writtenSql()).toBe(`NOTIFY pgrst, 'reload config';\nNOTIFY pgrst, 'reload schema';`)
      expect(writtenSql()).not.toContain('pgrst.db_pool')
      expect(writtenSql()).not.toContain('RESET')
    })

    it('answers null for every pool field, whatever the body asked for', async () => {
      await expect(
        updatePostgrestConfig({
          max_rows: 500,
          db_pool: 25,
          db_pool_acquisition_timeout: 10,
          db_pool_max_idletime: 60,
          db_pool_max_lifetime: 3600,
        })
      ).resolves.toMatchObject({
        db_pool: null,
        db_pool_acquisition_timeout: null,
        db_pool_max_idletime: null,
        db_pool_max_lifetime: null,
      })
    })

    it('normalises the spacing of a schema list', async () => {
      await updatePostgrestConfig({ db_schema: ' public ,graphql_public,' })

      expect(writtenSql()).toContain(
        `ALTER ROLE authenticator IN DATABASE "${POSTGRES_DATABASE}" SET pgrst.db_schemas = 'public, graphql_public';`
      )
    })

    it('writes an empty extra search path when every entry is cleared', async () => {
      await updatePostgrestConfig({ db_extra_search_path: '' })

      expect(writtenSql()).toContain(
        `ALTER ROLE authenticator IN DATABASE "${POSTGRES_DATABASE}" SET pgrst.db_extra_search_path = '';`
      )
    })

    it('answers with the config as it now stands', async () => {
      executeQuery.mockResolvedValueOnce({ data: [], error: undefined })
      withRoleSettings('pgrst.db_schemas=public', 'pgrst.db_max_rows=500')

      await expect(updatePostgrestConfig({ db_schema: 'public', max_rows: 500 })).resolves.toEqual({
        db_schema: 'public',
        db_extra_search_path: 'public',
        max_rows: 500,
        db_pool: null,
        db_pool_acquisition_timeout: null,
        db_pool_max_idletime: null,
        db_pool_max_lifetime: null,
      })
    })

    it('surfaces a database error', async () => {
      executeQuery.mockResolvedValue({ data: undefined, error: new Error('permission denied') })

      await expect(updatePostgrestConfig({ max_rows: 500 })).rejects.toThrow('permission denied')
    })

    describe('refuses, and writes nothing, when', () => {
      const rejects = [
        ['a schema name carries SQL', { db_schema: 'public; drop table x' }],
        ['a schema name is quoted', { db_schema: 'public, "my schema"' }],
        ['a schema name starts with a digit', { db_schema: '1public' }],
        ['a schema name is longer than an identifier', { db_schema: 'a'.repeat(64) }],
        ['a search path entry carries SQL', { db_extra_search_path: "public'--" }],
        ['the schema list is empty', { db_schema: '' }],
        ['the schema list is only separators', { db_schema: ' , ' }],
        ['the schema list is not a string', { db_schema: ['public'] }],
        ['max rows is zero', { max_rows: 0 }],
        ['max rows is above a million', { max_rows: 1_000_001 }],
        ['max rows is fractional', { max_rows: 1.5 }],
        ['max rows is a string', { max_rows: '500' }],
      ] as const

      it.each(rejects)('%s', async (_name, body) => {
        await expect(
          updatePostgrestConfig(body as Parameters<typeof updatePostgrestConfig>[0])
        ).rejects.toBeInstanceOf(ServiceConfigValidationError)

        expect(executeQuery).not.toHaveBeenCalled()
      })
    })
  })

  describe('getExposedSchemas', () => {
    it('answers with the schemas the role carries', async () => {
      withDatabaseSettings('pgrst.db_schemas=public,api')

      await expect(getExposedSchemas()).resolves.toBe('public,api')
    })

    it('answers with the env when the role carries nothing', async () => {
      await expect(getExposedSchemas()).resolves.toBe(DEFAULT_EXPOSED_SCHEMAS)
    })

    it('answers with the env when the database cannot be reached', async () => {
      // Its callers are generating types and running lints. A stale schema list is a better answer
      // than refusing to do the thing they were asked for.
      executeQuery.mockResolvedValue({ data: undefined, error: new Error('connection refused') })

      await expect(getExposedSchemas()).resolves.toBe(DEFAULT_EXPOSED_SCHEMAS)
    })

    it('drops the spaces a save stores, and leaves the config field carrying them', async () => {
      // The shape the setting has from the first save on: `validateSchemaList` joins with ", " and
      // Postgres quotes a value holding a comma. The callers put the list into a URL query and
      // into schema lookups, where " newly_exposed" is a name nothing matches.
      withDatabaseSettings('pgrst.db_schemas="public, newly_exposed"')

      await expect(getExposedSchemas()).resolves.toBe('public,newly_exposed')
      // The settings page renders the spaced form, so the config keeps it.
      await expect(getPostgrestConfig()).resolves.toMatchObject({
        db_schema: 'public, newly_exposed',
      })
    })
  })

  describe('getExposedSchemas when PGRST_DB_SCHEMAS is itself spaced', () => {
    afterEach(() => {
      vi.doUnmock('../constants')
      vi.resetModules()
    })

    it('drops the spaces from the env fallback too', async () => {
      // `PGRST_DB_SCHEMAS` is written by hand in a compose file; nothing stops it being spaced.
      vi.resetModules()
      vi.doMock('../query', () => ({ executeQuery }))
      vi.doMock('../constants', async () => ({
        ...(await vi.importActual<typeof import('../constants')>('../constants')),
        DEFAULT_EXPOSED_SCHEMAS: 'public, graphql_public',
      }))
      const { getExposedSchemas: reloaded } = await import('./postgrest')
      executeQuery.mockResolvedValue({ data: undefined, error: new Error('connection refused') })

      await expect(reloaded()).resolves.toBe('public,graphql_public')
    })
  })

  describe('when POSTGRES_DB is not a name a setting can be scoped to', () => {
    const loadWithDatabase = async (name: string) => {
      vi.resetModules()
      vi.doMock('../query', () => ({ executeQuery }))
      vi.doMock('../constants', async () => ({
        ...(await vi.importActual<typeof import('../constants')>('../constants')),
        POSTGRES_DATABASE: name,
      }))
      return await import('./postgrest')
    }

    afterEach(() => {
      vi.doUnmock('../constants')
      vi.resetModules()
    })

    it.each(['my-db', 'db"; drop database postgres --', '1db', '', 'a'.repeat(64)])(
      'refuses to write, given %s',
      async (name) => {
        const { updatePostgrestConfig: update } = await loadWithDatabase(name)

        // Not a client error: the container's POSTGRES_DB is wrong, so this is a 500 to see.
        await expect(update({ max_rows: 500 })).rejects.toThrow(/POSTGRES_DB is not a name/)
        await expect(update({ max_rows: 500 })).rejects.not.toBeInstanceOf(
          ServiceConfigValidationError
        )
        expect(executeQuery).not.toHaveBeenCalled()
      }
    )

    it('writes as usual for a name that is a plain identifier', async () => {
      const { updatePostgrestConfig: update } = await loadWithDatabase('my_app')

      await update({ max_rows: 500 })

      expect(writtenSql()).toContain('IN DATABASE "my_app"')
    })
  })
})
