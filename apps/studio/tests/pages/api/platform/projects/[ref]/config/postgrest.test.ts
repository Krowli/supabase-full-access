import { components } from 'api-types'
import { createMocks } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import handler from '../../../../../../../pages/api/platform/projects/[ref]/config/postgrest'
import { POSTGRES_DATABASE } from '@/lib/api/self-hosted/constants'
import { mswServer } from '@/tests/lib/msw'

vi.mock('@/lib/constants', () => ({
  IS_PLATFORM: false,
  API_URL: 'https://api.example.com',
}))

const { executeQuery } = vi.hoisted(() => ({ executeQuery: vi.fn() }))
vi.mock('@/lib/api/self-hosted/query', () => ({ executeQuery }))

/** The role settings the next read sees, as `pg_db_role_setting` hands them over. */
const withRoleSettings = (...settings: string[]) => {
  executeQuery.mockResolvedValue({
    data: settings.map((setting) => ({ setdatabase: 0, setting })),
    error: undefined,
  })
}

describe('/api/platform/projects/[ref]/config/postgrest', () => {
  beforeEach(() => {
    // The handler does not hit the network; disable MSW so unrelated unhandled-request errors don't fire.
    mswServer.close()
    executeQuery.mockReset()
    withRoleSettings()
    vi.unstubAllEnvs()
    vi.stubEnv('PGRST_DB_EXTRA_SEARCH_PATH', undefined)
    vi.stubEnv('PGRST_DB_MAX_ROWS', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('Method handling', () => {
    it.each(['POST', 'DELETE'] as const)('should return 405 for %s', async (method) => {
      const { req, res } = createMocks({ method, query: { ref: 'default' } })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(405)
      expect(JSON.parse(res._getData())).toEqual({
        data: null,
        error: { message: `Method ${method} Not Allowed` },
      })
      expect(res.getHeader('Allow')).toEqual(['GET', 'PATCH'])
    })
  })

  describe('GET', () => {
    it('answers with the settings the authenticator role carries, db_pool included', async () => {
      withRoleSettings(
        'pgrst.db_schemas=public,api',
        'pgrst.db_extra_search_path=public,extensions',
        'pgrst.db_max_rows=500'
      )

      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(JSON.parse(res._getData())).toEqual({
        db_anon_role: 'anon',
        db_extra_search_path: 'public,extensions',
        db_pool: null,
        db_schema: 'public,api',
        jwt_secret: expect.any(String),
        max_rows: 500,
        role_claim_key: '.role',
      })
    })

    it('has db_pool in the answer, which the client widens the GET type for', async () => {
      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(JSON.parse(res._getData())).toHaveProperty('db_pool', null)
    })

    it('writes nothing', async () => {
      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
      await handler(req, res)

      expect(executeQuery).toHaveBeenCalledTimes(1)
      expect(executeQuery.mock.calls[0][0].query).not.toContain('ALTER ROLE')
    })
  })

  describe('PATCH', () => {
    it('writes the settings and answers with the config as it now stands', async () => {
      const body: components['schemas']['UpdatePostgrestConfigBody'] = {
        db_schema: 'public,graphql_public',
        db_extra_search_path: 'public,extensions',
        max_rows: 500,
        db_pool: 25,
      }
      const { req, res } = createMocks({ method: 'PATCH', query: { ref: 'default' }, body })

      executeQuery.mockResolvedValueOnce({ data: [], error: undefined })
      withRoleSettings(
        'pgrst.db_schemas="public, graphql_public"',
        'pgrst.db_extra_search_path="public, extensions"',
        'pgrst.db_max_rows=500'
      )

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(JSON.parse(res._getData())).toEqual({
        db_extra_search_path: 'public, extensions',
        db_pool: null,
        db_pool_acquisition_timeout: null,
        db_pool_max_idletime: null,
        db_pool_max_lifetime: null,
        db_schema: 'public, graphql_public',
        max_rows: 500,
      })

      // The pool size the body carried is accepted and dropped: it is not an in-database setting.
      expect(executeQuery.mock.calls[0][0].query).toBe(
        [
          `ALTER ROLE authenticator IN DATABASE "${POSTGRES_DATABASE}" SET pgrst.db_schemas = 'public, graphql_public';`,
          `ALTER ROLE authenticator IN DATABASE "${POSTGRES_DATABASE}" SET pgrst.db_extra_search_path = 'public, extensions';`,
          `ALTER ROLE authenticator IN DATABASE "${POSTGRES_DATABASE}" SET pgrst.db_max_rows = '500';`,
          `NOTIFY pgrst, 'reload config';`,
          `NOTIFY pgrst, 'reload schema';`,
        ].join('\n')
      )
    })

    it('refuses a schema name carrying SQL, and writes nothing', async () => {
      const { req, res } = createMocks({
        method: 'PATCH',
        query: { ref: 'default' },
        body: { db_schema: 'public; drop table x' },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(400)
      expect(JSON.parse(res._getData()).error.message).toMatch(/db_schema/)
      expect(executeQuery).not.toHaveBeenCalled()
    })

    it('refuses a max_rows the Data API could not serve, and writes nothing', async () => {
      const { req, res } = createMocks({
        method: 'PATCH',
        query: { ref: 'default' },
        body: { max_rows: 0 },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(400)
      expect(JSON.parse(res._getData()).error.message).toMatch(/max_rows/)
      expect(executeQuery).not.toHaveBeenCalled()
    })

    it('refuses a body that is not an object of settings', async () => {
      const { req, res } = createMocks({ method: 'PATCH', query: { ref: 'default' }, body: [] })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(400)
      expect(JSON.parse(res._getData()).error.message).toBe(
        'Body must be an object of Data API settings'
      )
      expect(executeQuery).not.toHaveBeenCalled()
    })

    it('turns a failure to write into a 500 rather than a 400', async () => {
      executeQuery.mockResolvedValue({ data: undefined, error: new Error('permission denied') })

      const { req, res } = createMocks({
        method: 'PATCH',
        query: { ref: 'default' },
        body: { max_rows: 500 },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(500)
    })
  })
})
