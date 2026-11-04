import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { readJsonState, writeJsonState } from '../auth-config/state'
import { ServiceConfigNotFoundError, ServiceConfigValidationError } from './errors'
import {
  createCredential,
  deleteCredential,
  getStorageConfig,
  getStorageConfigDir,
  listCredentials,
  STORAGE_ENV_FILE_NAME,
  STORAGE_STATE_FILE_NAME,
  updateStorageConfig,
} from './storage'

describe('api/self-hosted/service-config/storage', () => {
  let stateDir: string
  let configDir: string
  let warnSpy: MockInstance<(...args: unknown[]) => void>

  /** The file the storage container sources, as it stands on disk. */
  const envFile = () => readFileSync(join(configDir, STORAGE_ENV_FILE_NAME), 'utf8')

  /** The env file parsed back into the map that produced it. */
  const envMap = (): Record<string, string> =>
    Object.fromEntries(
      envFile()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
          const at = line.indexOf('=')
          return [line.slice(0, at), line.slice(at + 2, -1)]
        })
    )

  const state = () => readJsonState(STORAGE_STATE_FILE_NAME, stateDir)

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stateDir = mkdtempSync(join(tmpdir(), 'studio-storage-state-'))
    configDir = mkdtempSync(join(tmpdir(), 'studio-storage-env-'))
    vi.unstubAllEnvs()
    vi.stubEnv('STUDIO_AUTH_STATE_DIR', stateDir)
    vi.stubEnv('STORAGE_CONFIG_DIR', configDir)
    vi.stubEnv('UPLOAD_FILE_SIZE_LIMIT', undefined)
    vi.stubEnv('ENABLE_IMAGE_TRANSFORMATION', undefined)
    vi.stubEnv('S3_PROTOCOL_ENABLED', undefined)
    vi.stubEnv('S3_PROTOCOL_ACCESS_KEY_ID', undefined)
    vi.stubEnv('S3_PROTOCOL_ACCESS_KEY_SECRET', undefined)
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
    warnSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  describe('getStorageConfigDir', () => {
    it('falls back to /etc/studio-config when STORAGE_CONFIG_DIR is unset', () => {
      vi.stubEnv('STORAGE_CONFIG_DIR', undefined)

      expect(getStorageConfigDir()).toBe('/etc/studio-config')
    })

    it('reads STORAGE_CONFIG_DIR at call time', () => {
      vi.stubEnv('STORAGE_CONFIG_DIR', '/custom/storage')

      expect(getStorageConfigDir()).toBe('/custom/storage')
    })
  })

  describe('getStorageConfig with nothing saved', () => {
    it('answers with the settings the container environment is running', async () => {
      vi.stubEnv('UPLOAD_FILE_SIZE_LIMIT', '104857600')
      vi.stubEnv('ENABLE_IMAGE_TRANSFORMATION', 'true')
      vi.stubEnv('S3_PROTOCOL_ENABLED', 'false')

      const config = await getStorageConfig()

      expect(config.fileSizeLimit).toBe(104857600)
      expect(config.features.imageTransformation.enabled).toBe(true)
      expect(config.features.s3Protocol.enabled).toBe(false)
    })

    it('reports object versioning where the stack turns it on in storage-api', async () => {
      vi.stubEnv('STORAGE_VERSIONING_ENABLED', 'true')

      const config = await getStorageConfig()

      expect(config.capabilities.object_versioning).toBe(true)
    })

    it('answers with storage-api defaults when the environment says nothing', async () => {
      const config = await getStorageConfig()

      expect(config).toEqual({
        capabilities: { iceberg_catalog: false, list_v2: false, object_versioning: false },
        external: { upstreamTarget: 'main' },
        features: {
          icebergCatalog: { enabled: false, maxCatalogs: 0, maxNamespaces: 0, maxTables: 0 },
          imageTransformation: { enabled: false },
          purgeCache: { enabled: false },
          s3Protocol: { enabled: true },
          vectorBuckets: { enabled: false, maxBuckets: 0, maxIndexes: 0 },
        },
        fileSizeLimit: 52428800,
        migrationVersion: null,
      })
    })

    it('reads ENABLE_IMAGE_TRANSFORMATION as off unless it says exactly true', async () => {
      vi.stubEnv('ENABLE_IMAGE_TRANSFORMATION', 'yes')

      expect((await getStorageConfig()).features.imageTransformation.enabled).toBe(false)
    })

    it('reads S3_PROTOCOL_ENABLED as on unless it says exactly false', async () => {
      vi.stubEnv('S3_PROTOCOL_ENABLED', 'no')

      expect((await getStorageConfig()).features.s3Protocol.enabled).toBe(true)
    })

    it('falls back to 50 MB and says so when UPLOAD_FILE_SIZE_LIMIT is not a number', async () => {
      vi.stubEnv('UPLOAD_FILE_SIZE_LIMIT', '50MB')

      expect((await getStorageConfig()).fileSizeLimit).toBe(52428800)
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('UPLOAD_FILE_SIZE_LIMIT')
    })

    it('writes nothing on a read', async () => {
      await getStorageConfig()

      expect(await state()).toEqual({})
      expect(() => envFile()).toThrow()
    })
  })

  describe('getStorageConfig with settings saved', () => {
    it('prefers what was saved over the container environment', async () => {
      vi.stubEnv('UPLOAD_FILE_SIZE_LIMIT', '104857600')
      await writeJsonState(
        STORAGE_STATE_FILE_NAME,
        { fileSizeLimit: 209715200, imageTransformation: true },
        stateDir
      )

      const config = await getStorageConfig()

      expect(config.fileSizeLimit).toBe(209715200)
      expect(config.features.imageTransformation.enabled).toBe(true)
    })

    it('falls back per field, not all or nothing', async () => {
      vi.stubEnv('UPLOAD_FILE_SIZE_LIMIT', '104857600')
      vi.stubEnv('ENABLE_IMAGE_TRANSFORMATION', 'true')
      await writeJsonState(STORAGE_STATE_FILE_NAME, { s3ProtocolEnabled: false }, stateDir)

      const config = await getStorageConfig()

      expect(config.fileSizeLimit).toBe(104857600)
      expect(config.features.imageTransformation.enabled).toBe(true)
      expect(config.features.s3Protocol.enabled).toBe(false)
    })

    it('ignores a saved value of the wrong shape, and says so', async () => {
      await writeJsonState(
        STORAGE_STATE_FILE_NAME,
        { fileSizeLimit: 'lots', imageTransformation: 'yes' },
        stateDir
      )

      const config = await getStorageConfig()

      expect(config.fileSizeLimit).toBe(52428800)
      expect(config.features.imageTransformation.enabled).toBe(false)
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('fileSizeLimit')
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('imageTransformation')
    })
  })

  describe('updateStorageConfig from the settings form', () => {
    /** Exactly what `StorageSettings.tsx` sends: the limit, and both feature toggles it was shown. */
    const settingsFormBody = {
      fileSizeLimit: 104857600,
      features: {
        imageTransformation: { enabled: true },
        s3Protocol: { enabled: true },
      },
    }

    it('saves the limit and both toggles, and answers with the new config', async () => {
      const config = await updateStorageConfig(settingsFormBody)

      expect(config.fileSizeLimit).toBe(104857600)
      expect(config.features.imageTransformation.enabled).toBe(true)
      expect(config.features.s3Protocol.enabled).toBe(true)
      expect(await state()).toEqual({
        fileSizeLimit: 104857600,
        imageTransformation: true,
        s3ProtocolEnabled: true,
      })
    })

    it('renders the env file the storage container sources', async () => {
      await updateStorageConfig(settingsFormBody)

      expect(envFile()).toBe(
        [
          'ENABLE_IMAGE_TRANSFORMATION="true"',
          'FILE_SIZE_LIMIT="104857600"',
          'IMAGE_TRANSFORMATION_ENABLED="true"',
          'S3_PROTOCOL_ACCESS_KEY_ID=""',
          'S3_PROTOCOL_ACCESS_KEY_SECRET=""',
          'S3_PROTOCOL_ENABLED="true"',
          'UPLOAD_FILE_SIZE_LIMIT="104857600"',
          'UPLOAD_FILE_SIZE_LIMIT_STANDARD="104857600"',
          '',
        ].join('\n')
      )
    })

    it('writes the limit under the name upstream compose uses as well', async () => {
      // A stack built from `docker/docker-compose.yml` rather than the Coolify template spells the
      // limit `FILE_SIZE_LIMIT` on the storage service. Without this line that stack keeps its
      // compose limit through every save, with nothing saying so.
      await updateStorageConfig({ fileSizeLimit: 104857600 })

      expect(envMap().FILE_SIZE_LIMIT).toBe('104857600')
      expect(envMap().UPLOAD_FILE_SIZE_LIMIT).toBe('104857600')
    })

    it('keeps the S3 protocol toggle the S3 page saved', async () => {
      await updateStorageConfig({ features: { s3Protocol: { enabled: false } } })

      const config = await updateStorageConfig(settingsFormBody)

      // The form sends whatever `s3Protocol` the GET showed it, so the two pages agree — but the
      // merge is what makes a form that omitted it leave the saved value alone.
      expect(config.features.s3Protocol.enabled).toBe(true)
      expect((await state()).s3ProtocolEnabled).toBe(true)
    })

    it('leaves the S3 protocol toggle alone when the body omits it', async () => {
      await updateStorageConfig({ features: { s3Protocol: { enabled: false } } })

      const config = await updateStorageConfig({
        fileSizeLimit: 104857600,
        features: { imageTransformation: { enabled: true } },
      })

      expect(config.features.s3Protocol.enabled).toBe(false)
      expect(envMap().S3_PROTOCOL_ENABLED).toBe('false')
    })

    it('accepts and discards the features self-hosted storage does not have', async () => {
      const config = await updateStorageConfig({
        fileSizeLimit: 104857600,
        features: {
          imageTransformation: { enabled: true },
          icebergCatalog: { enabled: true, maxCatalogs: 5, maxNamespaces: 5, maxTables: 5 },
          vectorBuckets: { enabled: true, maxBuckets: 5, maxIndexes: 5 },
          purgeCache: { enabled: true },
        },
      })

      expect(config.features.icebergCatalog).toEqual({
        enabled: false,
        maxCatalogs: 0,
        maxNamespaces: 0,
        maxTables: 0,
      })
      expect(config.features.vectorBuckets).toEqual({
        enabled: false,
        maxBuckets: 0,
        maxIndexes: 0,
      })
      expect(config.features.purgeCache).toEqual({ enabled: false })
      expect(Object.keys(await state()).sort()).toEqual(['fileSizeLimit', 'imageTransformation'])
    })

    it('accepts and discards external', async () => {
      await updateStorageConfig({ external: { upstreamTarget: 'canary' }, fileSizeLimit: 1024 })

      expect((await getStorageConfig()).external).toEqual({ upstreamTarget: 'main' })
      expect(await state()).toEqual({ fileSizeLimit: 1024 })
    })
  })

  describe('updateStorageConfig from the S3 page', () => {
    /** `S3Connection.tsx` sends `...config.features` with only `s3Protocol` replaced. */
    const s3PageBody = (enabled: boolean) => ({
      features: {
        icebergCatalog: { enabled: false, maxCatalogs: 0, maxNamespaces: 0, maxTables: 0 },
        imageTransformation: { enabled: true },
        purgeCache: { enabled: false },
        s3Protocol: { enabled },
        vectorBuckets: { enabled: false, maxBuckets: 0, maxIndexes: 0 },
      },
    })

    it('keeps the file size limit the settings form saved', async () => {
      await updateStorageConfig({ fileSizeLimit: 209715200 })

      const config = await updateStorageConfig(s3PageBody(false))

      expect(config.fileSizeLimit).toBe(209715200)
      expect(config.features.s3Protocol.enabled).toBe(false)
      expect(envMap().UPLOAD_FILE_SIZE_LIMIT).toBe('209715200')
      expect(envMap().S3_PROTOCOL_ENABLED).toBe('false')
    })

    it('renders the env file after the S3 save too', async () => {
      await updateStorageConfig(s3PageBody(false))

      expect(envFile()).toBe(
        [
          'ENABLE_IMAGE_TRANSFORMATION="true"',
          'FILE_SIZE_LIMIT="52428800"',
          'IMAGE_TRANSFORMATION_ENABLED="true"',
          'S3_PROTOCOL_ACCESS_KEY_ID=""',
          'S3_PROTOCOL_ACCESS_KEY_SECRET=""',
          'S3_PROTOCOL_ENABLED="false"',
          'UPLOAD_FILE_SIZE_LIMIT="52428800"',
          'UPLOAD_FILE_SIZE_LIMIT_STANDARD="52428800"',
          '',
        ].join('\n')
      )
    })

    it('keeps the S3 key pair in the file it renders', async () => {
      const created = await createCredential('production')

      await updateStorageConfig(s3PageBody(false))

      expect(envMap().S3_PROTOCOL_ACCESS_KEY_ID).toBe(created.access_key)
      expect(envMap().S3_PROTOCOL_ACCESS_KEY_SECRET).toBe(created.secret_key)
    })
  })

  describe('updateStorageConfig validation', () => {
    it.each([
      ['zero', 0],
      ['negative', -1],
      ['fractional', 1.5],
      ['a string', '104857600'],
      ['over 500 GB', 536870912001],
    ])('refuses a fileSizeLimit that is %s', async (_label, value) => {
      await expect(updateStorageConfig({ fileSizeLimit: value })).rejects.toThrow(
        ServiceConfigValidationError
      )
    })

    it.each([
      ['one byte', 1],
      ['exactly 500 GB', 536870912000],
    ])('accepts a fileSizeLimit of %s', async (_label, value) => {
      expect((await updateStorageConfig({ fileSizeLimit: value })).fileSizeLimit).toBe(value)
    })

    it('refuses a top-level key that is not a storage setting', async () => {
      await expect(updateStorageConfig({ tenantId: 'other' })).rejects.toThrow(/tenantId/)
    })

    it('refuses a feature that is not a storage setting', async () => {
      await expect(
        updateStorageConfig({ features: { teleport: { enabled: true } } })
      ).rejects.toThrow(/teleport/)
    })

    it.each([
      ['not an object', 'on'],
      ['missing enabled', {}],
      ['a stringly-typed enabled', { enabled: 'true' }],
    ])('refuses an imageTransformation that is %s', async (_label, value) => {
      await expect(
        updateStorageConfig({ features: { imageTransformation: value } })
      ).rejects.toThrow(/imageTransformation/)
    })

    it('refuses features that is not an object', async () => {
      await expect(updateStorageConfig({ features: [] })).rejects.toThrow(/features/)
    })

    it('writes neither the state nor the env file when the body is refused', async () => {
      await updateStorageConfig({ fileSizeLimit: 1024 })
      const before = envFile()

      await expect(updateStorageConfig({ fileSizeLimit: 0 })).rejects.toThrow()

      expect(await state()).toEqual({ fileSizeLimit: 1024 })
      expect(envFile()).toBe(before)
    })

    it('takes null as "leave it alone"', async () => {
      await updateStorageConfig({ fileSizeLimit: 1024 })

      const config = await updateStorageConfig({ fileSizeLimit: null, features: null })

      expect(config.fileSizeLimit).toBe(1024)
    })

    it('takes an empty body as a no-op that still renders the file', async () => {
      const config = await updateStorageConfig({})

      expect(config.fileSizeLimit).toBe(52428800)
      expect(envMap().UPLOAD_FILE_SIZE_LIMIT).toBe('52428800')
    })
  })

  describe('listCredentials', () => {
    it('answers with nothing when the environment carries no key pair', async () => {
      expect(await listCredentials()).toEqual({ data: [] })
    })

    it('answers with the key pair from the container environment', async () => {
      vi.stubEnv('S3_PROTOCOL_ACCESS_KEY_ID', 'SBFROMCOMPOSE12345AB')
      vi.stubEnv('S3_PROTOCOL_ACCESS_KEY_SECRET', 'compose-secret')

      const { data } = await listCredentials()

      expect(data).toHaveLength(1)
      expect(data[0]).toMatchObject({
        id: 'env',
        description: 'From container environment',
        access_key: 'SBFROMCOMPOSE12345AB',
      })
      expect(Date.parse(data[0].created_at)).not.toBeNaN()
    })

    it('needs both halves of the pair before it reports one', async () => {
      vi.stubEnv('S3_PROTOCOL_ACCESS_KEY_ID', 'SBFROMCOMPOSE12345AB')

      expect(await listCredentials()).toEqual({ data: [] })
    })

    it('never reports the secret', async () => {
      const created = await createCredential('production')

      const { data } = await listCredentials()

      expect(JSON.stringify(data)).not.toContain(created.secret_key)
      expect(Object.keys(data[0]).sort()).toEqual(['access_key', 'created_at', 'description', 'id'])
    })
  })

  describe('createCredential', () => {
    it('answers with a key pair and remembers it', async () => {
      const created = await createCredential('production')

      expect(created.description).toBe('production')
      expect(created.access_key).toMatch(/^SB[A-Z0-9]{18}$/)
      expect(created.secret_key).toMatch(/^[A-Za-z0-9_-]{40}$/)
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/)

      const { data } = await listCredentials()
      expect(data[0]).toMatchObject({ id: created.id, access_key: created.access_key })
    })

    it('writes the pair into the env file', async () => {
      const created = await createCredential('production')

      expect(envMap().S3_PROTOCOL_ACCESS_KEY_ID).toBe(created.access_key)
      expect(envMap().S3_PROTOCOL_ACCESS_KEY_SECRET).toBe(created.secret_key)
    })

    it('leaves the other settings as they were', async () => {
      await updateStorageConfig({
        fileSizeLimit: 1024,
        features: { s3Protocol: { enabled: true } },
      })

      await createCredential('production')

      expect(envMap().UPLOAD_FILE_SIZE_LIMIT).toBe('1024')
      expect((await getStorageConfig()).fileSizeLimit).toBe(1024)
    })

    it('issues a different pair every time', async () => {
      const first = await createCredential('first')
      await deleteCredential(first.id)
      const second = await createCredential('second')

      expect(second.access_key).not.toBe(first.access_key)
      expect(second.secret_key).not.toBe(first.secret_key)
    })

    it('refuses a second key while one is live', async () => {
      await createCredential('production')

      await expect(createCredential('staging')).rejects.toThrow(
        'Self-hosted storage supports a single S3 access key; revoke the existing one first'
      )
    })

    it('counts the pair from the container environment as the one key', async () => {
      vi.stubEnv('S3_PROTOCOL_ACCESS_KEY_ID', 'SBFROMCOMPOSE12345AB')
      vi.stubEnv('S3_PROTOCOL_ACCESS_KEY_SECRET', 'compose-secret')

      await expect(createCredential('production')).rejects.toThrow(ServiceConfigValidationError)
    })

    it.each([
      ['empty', ''],
      ['whitespace', '   '],
      ['not a string', 42],
    ])('refuses a description that is %s', async (_label, value) => {
      await expect(createCredential(value)).rejects.toThrow(
        'description must be a non-empty string'
      )
    })

    it('stores the description trimmed', async () => {
      // It is what the S3 table renders; the whitespace around a pasted name is not the name.
      const created = await createCredential('  production  ')

      expect(created.description).toBe('production')

      const { data } = await listCredentials()
      expect(data[0].description).toBe('production')
    })

    it('refuses a description longer than 200 characters', async () => {
      await expect(createCredential('a'.repeat(201))).rejects.toBeInstanceOf(
        ServiceConfigValidationError
      )
      await expect(createCredential('a'.repeat(201))).rejects.toThrow(
        'description must be at most 200 characters'
      )
    })

    it('takes a description of exactly 200 characters', async () => {
      const created = await createCredential('a'.repeat(200))

      expect(created.description).toHaveLength(200)
    })

    it('measures the length after trimming', async () => {
      const created = await createCredential(`  ${'a'.repeat(200)}  `)

      expect(created.description).toBe('a'.repeat(200))
    })

    it('writes nothing when the description is refused', async () => {
      await expect(createCredential('a'.repeat(201))).rejects.toThrow(ServiceConfigValidationError)

      expect((await listCredentials()).data).toEqual([])
    })
  })

  describe('deleteCredential', () => {
    it('empties both S3 names in the env file', async () => {
      const created = await createCredential('production')

      await deleteCredential(created.id)

      expect(await listCredentials()).toEqual({ data: [] })
      expect(envMap().S3_PROTOCOL_ACCESS_KEY_ID).toBe('')
      expect(envMap().S3_PROTOCOL_ACCESS_KEY_SECRET).toBe('')
    })

    it('keeps the key from the container environment from coming back', async () => {
      vi.stubEnv('S3_PROTOCOL_ACCESS_KEY_ID', 'SBFROMCOMPOSE12345AB')
      vi.stubEnv('S3_PROTOCOL_ACCESS_KEY_SECRET', 'compose-secret')

      await deleteCredential('env')

      // Studio's own container still has the compose value; only the tombstone stops the next read
      // from presenting a key storage-api will no longer accept.
      expect(await listCredentials()).toEqual({ data: [] })
      expect((await state()).s3Credential).toBe(null)
      expect(envMap().S3_PROTOCOL_ACCESS_KEY_ID).toBe('')
    })

    it('lets a new key be issued afterwards', async () => {
      const created = await createCredential('production')
      await deleteCredential(created.id)

      const second = await createCredential('staging')

      expect((await listCredentials()).data[0]).toMatchObject({ id: second.id })
    })

    it('refuses an id that is not the live key', async () => {
      const created = await createCredential('production')

      await expect(deleteCredential('some-other-id')).rejects.toThrow(ServiceConfigNotFoundError)
      expect((await listCredentials()).data[0]).toMatchObject({ id: created.id })
    })

    it('refuses to revoke when there is nothing to revoke', async () => {
      await expect(deleteCredential('env')).rejects.toThrow(ServiceConfigNotFoundError)
    })

    it('leaves the other settings as they were', async () => {
      await updateStorageConfig({ fileSizeLimit: 1024 })
      const created = await createCredential('production')

      await deleteCredential(created.id)

      expect(envMap().UPLOAD_FILE_SIZE_LIMIT).toBe('1024')
      expect((await getStorageConfig()).fileSizeLimit).toBe(1024)
    })
  })

  describe('the files on disk', () => {
    it('writes the env file into STORAGE_CONFIG_DIR and the state beside the auth state', async () => {
      await updateStorageConfig({ fileSizeLimit: 1024 })

      expect(statSync(join(configDir, STORAGE_ENV_FILE_NAME)).isFile()).toBe(true)
      expect(statSync(join(stateDir, STORAGE_STATE_FILE_NAME)).isFile()).toBe(true)
    })

    it('leaves no temporary file behind', async () => {
      await createCredential('production')

      expect(readFileSync(join(configDir, STORAGE_ENV_FILE_NAME), 'utf8')).toContain(
        'S3_PROTOCOL_ACCESS_KEY_ID'
      )
      expect(readdirSync(configDir).filter((name) => name.includes('.tmp.'))).toEqual([])
    })
  })
})
