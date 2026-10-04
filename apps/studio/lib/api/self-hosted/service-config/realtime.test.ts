import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { writeJsonState } from '../auth-config/state'
import { AUTH_JWT_SECRET } from '../constants'
import { ServiceConfigValidationError, ServiceUnavailableError } from './errors'
import { getRealtimeConfig, REALTIME_STATE_FILE_NAME, updateRealtimeConfig } from './realtime'

const fetchMock = vi.fn()

const { executeQuery } = vi.hoisted(() => ({ executeQuery: vi.fn() }))
vi.mock('../query', () => ({ executeQuery }))

/**
 * The tenant row as `_realtime.tenants` holds it — all nine columns, which is what the read path
 * uses. `null` is what Realtime leaves a limit at until `maybe_set_default` fills it.
 */
const tenantRow = (overrides: Record<string, unknown> = {}) => ({
  max_concurrent_users: 200,
  max_events_per_second: 100,
  max_bytes_per_second: 100_000,
  max_channels_per_client: 100,
  max_joins_per_second: 100,
  max_presence_events_per_second: 1000,
  max_payload_size_in_kb: 3000,
  private_only: false,
  suspend: false,
  ...overrides,
})

/** The tenant row the next read sees. */
const databaseHolds = (overrides: Record<string, unknown> = {}) => {
  const row = tenantRow(overrides)
  executeQuery.mockResolvedValue({ data: [row], error: undefined })
  return row
}

/** The SQL of the read, which is the only query this module sends. */
const readSql = (): string => executeQuery.mock.calls[0][0].query

/** The values bound to that query, which is where the tenant id travels. */
const readParameters = (): unknown[] => executeQuery.mock.calls[0][0].parameters

/** The tenant row cannot be read, so the module falls back to Realtime's HTTP API. */
const databaseUnavailable = () => {
  executeQuery.mockResolvedValue({
    data: undefined,
    error: new Error('schema "_realtime" does not exist'),
  })
}

/**
 * The tenant as Realtime's `TenantView.render("tenant.json")` serialises it at v2.76.5 — which is
 * five of the nine settings this module writes. `max_bytes_per_second`,
 * `max_presence_events_per_second`, `max_payload_size_in_kb` and `suspend` are columns the
 * controller happily writes and the view never hands back. Only the fallback read sees this shape.
 */
const tenant = (overrides: Record<string, unknown> = {}) => ({
  id: '4b2a1f6e-1f1a-4a1e-9f4d-0b0a4c6d5e7f',
  external_id: 'realtime-dev',
  name: 'realtime-dev',
  max_concurrent_users: 200,
  max_channels_per_client: 100,
  max_events_per_second: 100,
  max_joins_per_second: 100,
  inserted_at: '2026-01-01T00:00:00',
  extensions: [
    {
      type: 'postgres_cdc_rls',
      settings: { db_name: 'postgres', db_host: 'supabase-db', region: 'us-east-1' },
    },
  ],
  private_only: false,
  max_client_presence_events_per_window: 5,
  client_presence_window_ms: 30_000,
  ...overrides,
})

const ok = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as Response

/** Realtime answers every call with this tenant, whichever method asked. */
const realtimeHolds = (overrides: Record<string, unknown> = {}) => {
  const current = tenant(overrides)
  fetchMock.mockImplementation(() => Promise.resolve(ok({ data: current })))
  return current
}

const callsTo = (method: string) =>
  fetchMock.mock.calls.filter(([, init]) => init.method === method)

/** The `tenant` object of the one PUT that was sent. */
const putBody = (): Record<string, unknown> => {
  const [, init] = callsTo('PUT')[0]
  return JSON.parse(init.body).tenant
}

describe('api/self-hosted/service-config/realtime', () => {
  let dir: string
  let warnSpy: MockInstance<(...args: unknown[]) => void>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-realtime-state-'))
    fetchMock.mockReset()
    executeQuery.mockReset()
    databaseHolds()
    realtimeHolds()
    // Silenced as well as observed: several tests below deliberately run the degraded paths, which
    // warn by design, and a passing suite should not print them.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock)
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

  /** Everything the module warned about during one call, as one string. */
  const warnings = (): string => warnSpy.mock.calls.map((call) => String(call[0])).join('\n')

  const readStateFile = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, REALTIME_STATE_FILE_NAME), 'utf8'))

  describe('getRealtimeConfig', () => {
    it('answers with the tenant row when nothing has been saved from the UI', async () => {
      databaseHolds({
        max_concurrent_users: 500,
        max_events_per_second: 250,
        max_channels_per_client: 42,
        max_joins_per_second: 77,
        private_only: true,
      })

      const config = await getRealtimeConfig()

      expect(config).toMatchObject({
        max_concurrent_users: 500,
        max_events_per_second: 250,
        max_channels_per_client: 42,
        max_joins_per_second: 77,
        private_only: true,
      })
    })

    it('answers with the four columns the HTTP view would never have reported', async () => {
      databaseHolds({
        max_bytes_per_second: 250_000,
        max_presence_events_per_second: 750,
        max_payload_size_in_kb: 1500,
        suspend: true,
      })

      const config = await getRealtimeConfig()

      expect(config).toMatchObject({
        max_bytes_per_second: 250_000,
        max_presence_events_per_second: 750,
        max_payload_size_in_kb: 1500,
        suspend: true,
      })
    })

    it('touches Realtime not at all when nothing has been saved from the UI', async () => {
      await getRealtimeConfig()

      expect(fetchMock).not.toHaveBeenCalled()
      expect(executeQuery).toHaveBeenCalledTimes(1)
    })

    it('falls back to Realtime’s own defaults for a column the row leaves null', async () => {
      databaseHolds({
        max_bytes_per_second: null,
        max_presence_events_per_second: null,
        max_payload_size_in_kb: null,
        suspend: null,
      })

      const config = await getRealtimeConfig()

      // From `Realtime.Api.Tenant`'s schema defaults and `config/runtime.exs` at v2.76.5 — not from
      // the UI's `REALTIME_DEFAULT_CONFIG`, which guesses 100 for two of them.
      expect(config).toMatchObject({
        max_bytes_per_second: 100_000,
        max_presence_events_per_second: 1000,
        max_payload_size_in_kb: 3000,
        suspend: false,
      })
    })

    it('answers the settings Realtime has no column for from the UI defaults', async () => {
      const config = await getRealtimeConfig()

      expect(config).toMatchObject({
        connection_pool: 2,
        postgres_changes_pool: 2,
        presence_enabled: true,
      })
    })

    it('prefers the saved value for a setting Realtime has no column for', async () => {
      await writeJsonState(
        REALTIME_STATE_FILE_NAME,
        { connection_pool: 9, postgres_changes_pool: 7, presence_enabled: false },
        dir
      )

      const config = await getRealtimeConfig()

      expect(config).toMatchObject({
        connection_pool: 9,
        postgres_changes_pool: 7,
        presence_enabled: false,
      })
    })

    it('re-applies the saved settings when the live tenant has drifted away from them', async () => {
      databaseHolds({ max_concurrent_users: 200, max_events_per_second: 100 })
      await writeJsonState(
        REALTIME_STATE_FILE_NAME,
        { max_concurrent_users: 1000, max_events_per_second: 500 },
        dir
      )

      const config = await getRealtimeConfig()

      expect(callsTo('PUT')).toHaveLength(1)
      expect(putBody()).toEqual({ max_concurrent_users: 1000, max_events_per_second: 500 })
      expect(config).toMatchObject({ max_concurrent_users: 1000, max_events_per_second: 500 })
    })

    it('never sends the CDC extension back, which would be deleted on replace', async () => {
      await writeJsonState(REALTIME_STATE_FILE_NAME, { max_concurrent_users: 1000 }, dir)

      await getRealtimeConfig()

      expect(putBody()).not.toHaveProperty('extensions')
      expect(JSON.stringify(putBody())).not.toContain('postgres_cdc_rls')
    })

    it('never sends a setting Realtime has no column for', async () => {
      await writeJsonState(
        REALTIME_STATE_FILE_NAME,
        {
          max_concurrent_users: 1000,
          connection_pool: 9,
          postgres_changes_pool: 7,
          presence_enabled: false,
        },
        dir
      )

      await getRealtimeConfig()

      expect(putBody()).toEqual({ max_concurrent_users: 1000 })
    })

    it('leaves the live tenant alone when every saved setting already matches it', async () => {
      databaseHolds({ max_concurrent_users: 1000 })
      await writeJsonState(
        REALTIME_STATE_FILE_NAME,
        { max_concurrent_users: 1000, connection_pool: 9 },
        dir
      )

      await getRealtimeConfig()

      expect(callsTo('PUT')).toHaveLength(0)
    })

    it('writes nothing on a read where every one of the nine already matches', async () => {
      // The whole point of reading the row: `suspend` and the payload limit are in it, so a tenant
      // that is already right is left alone instead of being written back on every page load.
      const row = databaseHolds()
      await writeJsonState(REALTIME_STATE_FILE_NAME, { ...row }, dir)

      await getRealtimeConfig()

      expect(callsTo('PUT')).toHaveLength(0)
    })

    it('re-applies a saved payload limit the tenant was re-seeded away from', async () => {
      // `max_payload_size_in_kb` is not in `TenantView`'s output, so only the row can show that a
      // restart put it back to 3000.
      databaseHolds({ max_payload_size_in_kb: 3000 })
      await writeJsonState(REALTIME_STATE_FILE_NAME, { max_payload_size_in_kb: 500 }, dir)

      const config = await getRealtimeConfig()

      expect(callsTo('PUT')).toHaveLength(1)
      expect(putBody()).toEqual({ max_payload_size_in_kb: 500 })
      expect(config).toMatchObject({ max_payload_size_in_kb: 500 })
    })

    it('re-applies a saved suspend flag the tenant was re-seeded away from', async () => {
      databaseHolds({ suspend: false })
      await writeJsonState(REALTIME_STATE_FILE_NAME, { suspend: true }, dir)

      const config = await getRealtimeConfig()

      expect(putBody()).toEqual({ suspend: true })
      expect(config).toMatchObject({ suspend: true })
    })

    it('still answers, with the saved values, when the reconcile write is refused', async () => {
      databaseHolds({ max_concurrent_users: 200 })
      await writeJsonState(REALTIME_STATE_FILE_NAME, { max_concurrent_users: 1000 }, dir)
      fetchMock.mockImplementation((_url: string, init: { method: string }) =>
        init.method === 'PUT'
          ? Promise.resolve({
              ok: false,
              status: 422,
              text: () => Promise.resolve('{"errors":{"max_concurrent_users":["is invalid"]}}'),
            } as unknown as Response)
          : Promise.resolve(ok({ data: tenant() }))
      )

      const config = await getRealtimeConfig()

      // A settings page that cannot write is still a settings page. It shows what was asked for,
      // says so in the log, and the next read tries the reconcile again.
      expect(config).toMatchObject({ max_concurrent_users: 1000 })
      expect(warnings()).toContain('could not re-apply the saved Realtime settings')
      expect(warnings()).toContain('422')
    })

    it('still answers when Realtime cannot be reached for the reconcile write', async () => {
      databaseHolds({ max_concurrent_users: 200 })
      await writeJsonState(REALTIME_STATE_FILE_NAME, { max_concurrent_users: 1000 }, dir)
      fetchMock.mockRejectedValue(new TypeError('fetch failed'))

      await expect(getRealtimeConfig()).resolves.toMatchObject({ max_concurrent_users: 1000 })
    })

    it('keeps the live value for a setting that was never saved, even while reconciling', async () => {
      databaseHolds({ max_concurrent_users: 200, max_joins_per_second: 333 })
      await writeJsonState(REALTIME_STATE_FILE_NAME, { max_concurrent_users: 1000 }, dir)

      const config = await getRealtimeConfig()

      expect(putBody()).toEqual({ max_concurrent_users: 1000 })
      expect(config).toMatchObject({ max_joins_per_second: 333 })
    })

    it('ignores a state file whose value is the wrong shape for the setting', async () => {
      await writeJsonState(
        REALTIME_STATE_FILE_NAME,
        { max_concurrent_users: 'lots', private_only: 'yes' },
        dir
      )

      const config = await getRealtimeConfig()

      expect(callsTo('PUT')).toHaveLength(0)
      expect(config).toMatchObject({ max_concurrent_users: 200, private_only: false })
    })
  })

  describe('reading the tenant row', () => {
    it('asks for the nine columns of the one tenant, by name', async () => {
      await getRealtimeConfig()

      expect(readSql()).toBe(
        'select max_concurrent_users, max_events_per_second, max_bytes_per_second, ' +
          'max_channels_per_client, max_joins_per_second, max_presence_events_per_second, ' +
          'max_payload_size_in_kb, private_only, suspend from _realtime.tenants where external_id = $1'
      )
      expect(readParameters()).toEqual(['realtime-dev'])
    })

    it('follows REALTIME_TENANT_ID into the bound parameter', async () => {
      vi.stubEnv('REALTIME_TENANT_ID', 'my-tenant-2')

      await getRealtimeConfig()

      expect(readParameters()).toEqual(['my-tenant-2'])
    })

    it.each(['dev_tenant', 'Tenant', 'my tenant', "o'brien"])(
      'reads the row for %j, which a name may legally be',
      async (tenantId) => {
        vi.stubEnv('REALTIME_TENANT_ID', tenantId)

        await getRealtimeConfig()

        expect(readParameters()).toEqual([tenantId])
        expect(fetchMock).not.toHaveBeenCalled()
      }
    )

    it('sends a name full of SQL as a value, never as part of the statement', async () => {
      const injection = "evil'; drop table _realtime.tenants; --"
      vi.stubEnv('REALTIME_TENANT_ID', injection)

      await getRealtimeConfig()

      expect(readSql()).not.toContain('drop table')
      expect(readSql()).toContain('external_id = $1')
      expect(readParameters()).toEqual([injection])
    })

    it('refuses an id no name could be, and reads over the API instead', async () => {
      vi.stubEnv('REALTIME_TENANT_ID', 'x'.repeat(256))

      await getRealtimeConfig()

      expect(executeQuery).not.toHaveBeenCalled()
      expect(callsTo('GET')).toHaveLength(1)
    })

    it('reads the default tenant when REALTIME_TENANT_ID is set to nothing', async () => {
      vi.stubEnv('REALTIME_TENANT_ID', '')

      await getRealtimeConfig()

      expect(readParameters()).toEqual(['realtime-dev'])
    })

    it('reads the row for the longest id it will accept', async () => {
      vi.stubEnv('REALTIME_TENANT_ID', 'x'.repeat(255))

      await getRealtimeConfig()

      expect(readParameters()).toEqual(['x'.repeat(255)])
    })
  })

  describe('the admin API fallback', () => {
    beforeEach(databaseUnavailable)

    it('reads the tenant over HTTP when its row cannot be read', async () => {
      const config = await getRealtimeConfig()

      const [url] = fetchMock.mock.calls[0]
      expect(url).toBe('http://realtime-dev:4000/api/tenants/realtime-dev')
      expect(config).toMatchObject({ max_concurrent_users: 200, private_only: false })
    })

    it('says in the log that four columns have stopped being readable', async () => {
      await getRealtimeConfig()

      expect(warnings()).toContain('could not read _realtime.tenants for realtime-dev')
      expect(warnings()).toContain('max_payload_size_in_kb')
      expect(warnings()).toContain('suspend')
    })

    it('falls back when the row is simply not there', async () => {
      executeQuery.mockResolvedValue({ data: [], error: undefined })

      await getRealtimeConfig()

      expect(callsTo('GET')).toHaveLength(1)
    })

    it('re-applies a saved column the HTTP view cannot report, drift being invisible there', async () => {
      await writeJsonState(REALTIME_STATE_FILE_NAME, { max_payload_size_in_kb: 500 }, dir)

      const config = await getRealtimeConfig()

      expect(callsTo('PUT')).toHaveLength(1)
      expect(putBody()).toEqual({ max_payload_size_in_kb: 500 })
      expect(config).toMatchObject({ max_payload_size_in_kb: 500 })
    })

    it('says so rather than answering with an empty configuration when the tenant is missing', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(ok({ data: null })))

      await expect(getRealtimeConfig()).rejects.toBeInstanceOf(ServiceUnavailableError)
      await expect(getRealtimeConfig()).rejects.toThrow('realtime-dev')
    })

    it('rethrows when Realtime cannot be reached either', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'))

      await expect(getRealtimeConfig()).rejects.toBeInstanceOf(ServiceUnavailableError)
    })
  })

  describe('addressing and authentication', () => {
    it('writes to the tenant Realtime serves on the compose network', async () => {
      await updateRealtimeConfig({ max_concurrent_users: 1000 })

      const [url] = fetchMock.mock.calls[0]
      expect(url).toBe('http://realtime-dev:4000/api/tenants/realtime-dev')
    })

    it('follows REALTIME_URL and REALTIME_TENANT_ID when the stack names them differently', async () => {
      vi.stubEnv('REALTIME_URL', 'http://rt.internal:4001')
      vi.stubEnv('REALTIME_TENANT_ID', 'my tenant')

      await updateRealtimeConfig({ max_concurrent_users: 1000 })

      const [url] = fetchMock.mock.calls[0]
      expect(url).toBe('http://rt.internal:4001/api/tenants/my%20tenant')
    })

    it('signs the bearer token with the secret Realtime holds as API_JWT_SECRET', async () => {
      await updateRealtimeConfig({ max_concurrent_users: 1000 })

      const [, init] = fetchMock.mock.calls[0]
      const token = String(init.headers.Authorization).replace('Bearer ', '')
      const [header, claims, signature] = token.split('.')

      expect(
        createHmac('sha256', AUTH_JWT_SECRET).update(`${header}.${claims}`).digest('base64url')
      ).toBe(signature)
      expect(JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')).exp).toBeGreaterThan(
        Math.floor(Date.now() / 1000)
      )
    })
  })

  describe('updateRealtimeConfig', () => {
    it('records the change and applies it to the tenant', async () => {
      await updateRealtimeConfig({ max_concurrent_users: 1000, private_only: true })

      expect(readStateFile()).toEqual({ max_concurrent_users: 1000, private_only: true })
      expect(callsTo('PUT')).toHaveLength(1)
      expect(putBody()).toEqual({ max_concurrent_users: 1000, private_only: true })
    })

    it('merges into what was saved before rather than replacing it', async () => {
      await writeJsonState(REALTIME_STATE_FILE_NAME, { max_events_per_second: 500 }, dir)

      await updateRealtimeConfig({ max_concurrent_users: 1000 })

      expect(readStateFile()).toEqual({ max_events_per_second: 500, max_concurrent_users: 1000 })
      expect(putBody()).toEqual({ max_events_per_second: 500, max_concurrent_users: 1000 })
    })

    it('keeps the settings Realtime has no column for out of the tenant it writes', async () => {
      await updateRealtimeConfig({
        connection_pool: 9,
        postgres_changes_pool: 7,
        presence_enabled: false,
        max_concurrent_users: 1000,
      })

      expect(readStateFile()).toMatchObject({
        connection_pool: 9,
        postgres_changes_pool: 7,
        presence_enabled: false,
      })
      expect(putBody()).toEqual({ max_concurrent_users: 1000 })
    })

    it('does not touch the tenant when nothing in the patch is a tenant setting', async () => {
      await updateRealtimeConfig({ connection_pool: 9 })

      expect(readStateFile()).toEqual({ connection_pool: 9 })
      expect(callsTo('PUT')).toHaveLength(0)
    })

    it('never sends the CDC extension back', async () => {
      await updateRealtimeConfig({ suspend: true })

      expect(putBody()).not.toHaveProperty('extensions')
    })

    it('records a value the tenant view cannot report, so a restart does not lose it', async () => {
      await updateRealtimeConfig({ max_payload_size_in_kb: 500, suspend: true })

      expect(readStateFile()).toEqual({ max_payload_size_in_kb: 500, suspend: true })
      expect(putBody()).toEqual({ max_payload_size_in_kb: 500, suspend: true })
    })

    it('treats a cleared field as "leave it where it is"', async () => {
      await updateRealtimeConfig({
        max_concurrent_users: undefined,
        max_events_per_second: null,
      } as never)

      expect(readStateFile()).toEqual({})
      expect(callsTo('PUT')).toHaveLength(0)
    })

    describe('validation', () => {
      const rejects = async (body: unknown, contains: string) => {
        await expect(updateRealtimeConfig(body as never)).rejects.toBeInstanceOf(
          ServiceConfigValidationError
        )
        await expect(updateRealtimeConfig(body as never)).rejects.toThrow(contains)
        expect(callsTo('PUT')).toHaveLength(0)
      }

      it.each([
        ['max_concurrent_users', 0],
        ['max_concurrent_users', 300_001],
        ['max_events_per_second', 50_001],
        ['max_presence_events_per_second', 5001],
        ['max_payload_size_in_kb', 3001],
        ['max_bytes_per_second', 1_000_001],
        ['max_channels_per_client', 1_000_001],
        ['max_joins_per_second', 1_000_001],
        ['connection_pool', 1_000_001],
        ['postgres_changes_pool', 0],
      ] as const)('refuses %s = %s', async (key, value) => {
        await rejects({ [key]: value }, key)
      })

      it('refuses a number that is not whole', async () => {
        await rejects({ max_concurrent_users: 10.5 }, 'max_concurrent_users')
      })

      it('refuses a number sent as a string', async () => {
        await rejects({ max_concurrent_users: '1000' }, 'max_concurrent_users')
      })

      it.each(['private_only', 'suspend', 'presence_enabled'] as const)(
        'refuses a non-boolean %s',
        async (key) => {
          await rejects({ [key]: 'true' }, key)
        }
      )

      it('refuses a key that is not a Realtime setting', async () => {
        await rejects({ jwt_secret: 'stolen' }, 'jwt_secret')
      })

      it('refuses a key that is a tenant column but not one this page owns', async () => {
        await rejects({ external_id: 'other-tenant' }, 'external_id')
      })

      it('writes no state when the patch is refused', async () => {
        await expect(updateRealtimeConfig({ max_concurrent_users: 0 } as never)).rejects.toThrow()

        expect(() => readStateFile()).toThrow()
      })
    })

    it('accepts the whole body the settings form sends', async () => {
      await updateRealtimeConfig({
        private_only: false,
        connection_pool: 2,
        postgres_changes_pool: 2,
        max_concurrent_users: 200,
        max_events_per_second: 100,
        max_presence_events_per_second: 100,
        max_payload_size_in_kb: 100,
        suspend: false,
      })

      expect(putBody()).toEqual({
        max_concurrent_users: 200,
        max_events_per_second: 100,
        max_presence_events_per_second: 100,
        max_payload_size_in_kb: 100,
        private_only: false,
        suspend: false,
      })
    })

    it('rethrows when Realtime refuses the changeset', async () => {
      fetchMock.mockImplementation((_url: string, init: { method: string }) =>
        init.method === 'PUT'
          ? Promise.resolve({
              ok: false,
              status: 422,
              text: () => Promise.resolve('{"errors":{"max_concurrent_users":["is invalid"]}}'),
            } as unknown as Response)
          : Promise.resolve(ok({ data: tenant() }))
      )

      await expect(updateRealtimeConfig({ max_concurrent_users: 1000 })).rejects.toBeInstanceOf(
        ServiceUnavailableError
      )
      // The record survives a failed write, so the next read re-applies it.
      expect(readStateFile()).toEqual({ max_concurrent_users: 1000 })
    })
  })
})
