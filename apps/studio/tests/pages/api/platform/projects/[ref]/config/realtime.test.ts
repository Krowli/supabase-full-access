import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMocks } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import handler from '../../../../../../../pages/api/platform/projects/[ref]/config/realtime'
import { writeJsonState } from '@/lib/api/self-hosted/auth-config/state'
import { mswServer } from '@/tests/lib/msw'

vi.mock('@/lib/constants', () => ({
  IS_PLATFORM: false,
  API_URL: 'https://api.example.com',
}))

const fetchMock = vi.fn()

const { executeQuery } = vi.hoisted(() => ({ executeQuery: vi.fn() }))
vi.mock('@/lib/api/self-hosted/query', () => ({ executeQuery }))

/** The tenant row as `_realtime.tenants` holds it, which is what a read answers from. */
const TENANT_ROW = {
  max_concurrent_users: 200,
  max_events_per_second: 100,
  max_bytes_per_second: 100_000,
  max_channels_per_client: 100,
  max_joins_per_second: 100,
  max_presence_events_per_second: 1000,
  max_payload_size_in_kb: 3000,
  private_only: false,
  suspend: false,
}

/** The tenant as Realtime's `TenantView` serialises it, wrapped the way the controller answers. */
const TENANT = {
  id: '4b2a1f6e-1f1a-4a1e-9f4d-0b0a4c6d5e7f',
  external_id: 'realtime-dev',
  name: 'realtime-dev',
  max_concurrent_users: 200,
  max_channels_per_client: 100,
  max_events_per_second: 100,
  max_joins_per_second: 100,
  inserted_at: '2026-01-01T00:00:00',
  extensions: [{ type: 'postgres_cdc_rls', settings: { db_name: 'postgres' } }],
  private_only: false,
  max_client_presence_events_per_window: 5,
  client_presence_window_ms: 30_000,
}

const ok = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as Response

describe('/api/platform/projects/[ref]/config/realtime', () => {
  let dir: string
  let warnSpy: MockInstance<(...args: unknown[]) => void>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dir = mkdtempSync(join(tmpdir(), 'studio-realtime-handler-'))
    // The handler talks to Realtime through a stubbed `fetch`; MSW would only report the call it
    // never sees as unhandled.
    mswServer.close()
    fetchMock.mockReset()
    fetchMock.mockImplementation(() => Promise.resolve(ok({ data: TENANT })))
    executeQuery.mockReset()
    executeQuery.mockResolvedValue({ data: [TENANT_ROW], error: undefined })
    vi.stubGlobal('fetch', fetchMock)
    vi.unstubAllEnvs()
    vi.stubEnv('STUDIO_AUTH_STATE_DIR', dir)
    vi.stubEnv('REALTIME_URL', undefined)
    vi.stubEnv('REALTIME_TENANT_ID', undefined)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    warnSpy.mockRestore()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  describe('Method handling', () => {
    it.each(['POST', 'DELETE', 'PUT'] as const)('should return 405 for %s', async (method) => {
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
    it('answers with the settings Realtime is running on', async () => {
      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(JSON.parse(res._getData())).toEqual({
        max_concurrent_users: 200,
        max_events_per_second: 100,
        max_bytes_per_second: 100_000,
        max_channels_per_client: 100,
        max_joins_per_second: 100,
        max_presence_events_per_second: 1000,
        max_payload_size_in_kb: 3000,
        private_only: false,
        suspend: false,
        connection_pool: 2,
        postgres_changes_pool: 2,
        presence_enabled: true,
        admin_suspended_at: null,
      })
    })

    it('reads the tenant row and touches Realtime not at all', async () => {
      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })

      await handler(req, res)

      expect(executeQuery).toHaveBeenCalledTimes(1)
      expect(executeQuery.mock.calls[0][0].query).toContain('from _realtime.tenants')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('answers 200 with the saved values when the reconcile write is refused', async () => {
      await writeJsonState('realtime-config.json', { max_concurrent_users: 1000 }, dir)
      fetchMock.mockImplementation((_url: string, init: { method: string }) =>
        init.method === 'PUT'
          ? Promise.resolve({
              ok: false,
              status: 422,
              text: () => Promise.resolve('{"errors":{"max_concurrent_users":["is invalid"]}}'),
            } as unknown as Response)
          : Promise.resolve(ok({ data: TENANT }))
      )
      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })

      await handler(req, res)

      // A write that did not land is a 502 on the PATCH, where somebody is waiting to hear it.
      // On a read it is a log line, and the page still renders what the operator asked for.
      expect(res._getStatusCode()).toBe(200)
      expect(JSON.parse(res._getData())).toMatchObject({ max_concurrent_users: 1000 })
    })

    it('answers 502 when neither the row nor Realtime can be reached', async () => {
      executeQuery.mockResolvedValue({ data: undefined, error: new Error('no such schema') })
      fetchMock.mockRejectedValue(new TypeError('fetch failed'))
      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(502)
      expect(JSON.parse(res._getData()).error.message).toContain('fetch failed')
    })

    it('answers 502, not 500, when Realtime has no such tenant', async () => {
      executeQuery.mockResolvedValue({ data: [], error: undefined })
      fetchMock.mockImplementation(() => Promise.resolve(ok({ data: null })))
      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(502)
      expect(JSON.parse(res._getData()).error.message).toContain('no tenant')
    })
  })

  describe('PATCH', () => {
    it('answers 204 with no body, and writes the settings to the tenant', async () => {
      const { req, res } = createMocks({
        method: 'PATCH',
        query: { ref: 'default' },
        body: { max_concurrent_users: 1000, private_only: true },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(204)
      expect(res._getData()).toBe('')

      const put = fetchMock.mock.calls.find(([, init]) => init.method === 'PUT')
      expect(put).toBeDefined()
      expect(JSON.parse(put![1].body)).toEqual({
        tenant: { max_concurrent_users: 1000, private_only: true },
      })
    })

    it('answers 400 for a value Realtime should not be given', async () => {
      const { req, res } = createMocks({
        method: 'PATCH',
        query: { ref: 'default' },
        body: { max_concurrent_users: 0 },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(400)
      expect(JSON.parse(res._getData()).error.message).toContain('max_concurrent_users')
      expect(fetchMock.mock.calls.some(([, init]) => init.method === 'PUT')).toBe(false)
    })

    it('answers 400 for a key that is not a Realtime setting', async () => {
      const { req, res } = createMocks({
        method: 'PATCH',
        query: { ref: 'default' },
        body: { jwt_secret: 'stolen' },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(400)
      expect(JSON.parse(res._getData()).error.message).toContain('jwt_secret')
    })

    it('answers 400 for a body that is not an object', async () => {
      const { req, res } = createMocks({ method: 'PATCH', query: { ref: 'default' }, body: [] })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(400)
      expect(JSON.parse(res._getData()).error.message).toContain('object')
    })

    it('answers 502 when Realtime refuses the changeset', async () => {
      fetchMock.mockImplementation((_url: string, init: { method: string }) =>
        init.method === 'PUT'
          ? Promise.resolve({
              ok: false,
              status: 422,
              text: () => Promise.resolve('{"errors":{"max_concurrent_users":["is invalid"]}}'),
            } as unknown as Response)
          : Promise.resolve(ok({ data: TENANT }))
      )
      const { req, res } = createMocks({
        method: 'PATCH',
        query: { ref: 'default' },
        body: { max_concurrent_users: 1000 },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(502)
      expect(JSON.parse(res._getData()).error.message).toContain('422')
    })

    it('answers 502 when Realtime cannot be reached', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'))
      const { req, res } = createMocks({
        method: 'PATCH',
        query: { ref: 'default' },
        body: { max_concurrent_users: 1000 },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(502)
    })
  })
})
