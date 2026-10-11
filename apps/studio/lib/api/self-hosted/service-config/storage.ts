import { randomBytes, randomUUID } from 'node:crypto'
import { components } from 'api-types'

import { renderEnvFile, writeEnvFile } from '../auth-config/render'
import { readJsonState, writeJsonState } from '../auth-config/state'
import { projectEnv } from '../project-context'
import { ServiceConfigNotFoundError, ServiceConfigValidationError } from './errors'

type StorageConfig = components['schemas']['StorageConfigResponse_Output']

/**
 * The Storage settings: remembered here, rendered into an env file, applied by a restart.
 *
 * This is the one settings page in this stage whose service cannot be told anything at run time.
 * storage-api reads `UPLOAD_FILE_SIZE_LIMIT`, `ENABLE_IMAGE_TRANSFORMATION`, `S3_PROTOCOL_ENABLED`
 * and the S3 protocol key pair once, at process start, and has no admin API and no config table
 * behind them. So a save writes `storage.env` into `STORAGE_CONFIG_DIR` — a host directory
 * bind-mounted into both containers — and the operator restarts the storage service, whose `command`
 * sources that file before it execs the server. The page says so, in an admonition, above the form.
 *
 * Because of that, Studio's own record is the only thing that can answer a read: the file it wrote
 * is not the config storage-api is running, and will not be until the restart. Reads therefore come
 * from `storage-config.json`, falling back per field to the same env names mirrored into Studio's
 * container, which is what a stack that has never been touched from the UI is running.
 *
 * Verified against supabase/storage 1.44.2: `src/config.ts` (`getConfig`, which reads every name
 * below once at import), `src/http/routes/s3/index.ts` and `src/storage/protocols/s3/`.
 */

/** Where Studio remembers what the Storage settings pages saved. */
export const STORAGE_STATE_FILE_NAME = 'storage-config.json'

/** The file the storage container's `command` sources before it starts the server. */
export const STORAGE_ENV_FILE_NAME = 'storage.env'

/**
 * The directory holding {@link STORAGE_ENV_FILE_NAME}, bind-mounted into Studio and into storage.
 * Read at call time so a test — and a compose file — can move it.
 */
export function getStorageConfigDir(): string {
  return projectEnv('STORAGE_CONFIG_DIR') ?? '/etc/studio-config'
}

/** storage-api's own default, and the one the compose file ships: 50 MiB. */
const DEFAULT_FILE_SIZE_LIMIT = 52_428_800

/**
 * 500 GB, the largest the settings form offers — `STORAGE_FILE_SIZE_LIMIT_MAX_BYTES_UNCAPPED` in
 * `components/interfaces/Storage/StorageSettings/StorageSettings.constants.ts`. The form caps what a
 * person can type; this caps what reaches the file, since the endpoint takes bodies the form did not
 * send.
 */
const MAX_FILE_SIZE_LIMIT = 536_870_912_000

/**
 * Studio has no logger module — server-side `lib` code writes to the console. These warnings are how
 * an operator learns that a value in the container environment could not be read and a default was
 * used instead; an env var's name and its unusable value are infrastructure, not anyone's data.
 */
const warn = (message: string): void => console.warn(`[storage-config] ${message}`)

/** The S3 protocol key pair, as Studio holds it. The secret never leaves this module. */
type StoredCredential = {
  id: string
  description: string
  access_key: string
  secret_key: string
  created_at: string
}

/** One row of `GET /platform/storage/{ref}/credentials`. The UI reads `access_key` off it too. */
export type StorageCredentialRow =
  components['schemas']['GetStorageCredentialsResponse_Output']['data'][number] & {
    access_key: string
  }

/**
 * What the two Storage pages have saved.
 *
 * `s3Credential` holds `null`, not nothing, once a key has been revoked. Revoking writes empty
 * strings into `storage.env`, which is how storage-api stops accepting the key — but Studio's own
 * container still has the compose `S3_PROTOCOL_ACCESS_KEY_ID` in its environment, and without the
 * tombstone the next read would fall back to it and show the revoked key as live.
 */
type StorageState = {
  fileSizeLimit?: number
  imageTransformation?: boolean
  s3ProtocolEnabled?: boolean
  s3Credential?: StoredCredential | null
}

/** Every setting this module owns, after state and the container environment have been combined. */
type ResolvedSettings = {
  fileSizeLimit: number
  imageTransformation: boolean
  s3ProtocolEnabled: boolean
  credential: StoredCredential | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A stored value of the wrong shape is ignored rather than trusted, and says so in the log. */
function storedNumber(state: Record<string, unknown>, key: string): number | undefined {
  const value = state[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    warn(`ignoring ${key} in ${STORAGE_STATE_FILE_NAME}: not a positive integer`)
    return undefined
  }
  return value
}

function storedBoolean(state: Record<string, unknown>, key: string): boolean | undefined {
  const value = state[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    warn(`ignoring ${key} in ${STORAGE_STATE_FILE_NAME}: not a boolean`)
    return undefined
  }
  return value
}

/** `undefined` means "nothing saved"; `null` means "saved as revoked". The two differ. */
function storedCredential(state: Record<string, unknown>): StoredCredential | null | undefined {
  if (!('s3Credential' in state)) return undefined
  const value = state.s3Credential
  if (value === null) return null
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.access_key !== 'string' ||
    typeof value.secret_key !== 'string' ||
    typeof value.created_at !== 'string'
  ) {
    warn(`ignoring s3Credential in ${STORAGE_STATE_FILE_NAME}: not a credential`)
    return undefined
  }
  return {
    id: value.id,
    description: value.description,
    access_key: value.access_key,
    secret_key: value.secret_key,
    created_at: value.created_at,
  }
}

async function readState(): Promise<StorageState> {
  const raw = await readJsonState(STORAGE_STATE_FILE_NAME)
  return {
    fileSizeLimit: storedNumber(raw, 'fileSizeLimit'),
    imageTransformation: storedBoolean(raw, 'imageTransformation'),
    s3ProtocolEnabled: storedBoolean(raw, 's3ProtocolEnabled'),
    s3Credential: storedCredential(raw),
  }
}

/** Only the keys that were actually set are written back, so the file stays the record of saves. */
async function writeState(state: StorageState): Promise<void> {
  const out: Record<string, unknown> = {}
  if (state.fileSizeLimit !== undefined) out.fileSizeLimit = state.fileSizeLimit
  if (state.imageTransformation !== undefined) out.imageTransformation = state.imageTransformation
  if (state.s3ProtocolEnabled !== undefined) out.s3ProtocolEnabled = state.s3ProtocolEnabled
  if (state.s3Credential !== undefined) out.s3Credential = state.s3Credential
  await writeJsonState(STORAGE_STATE_FILE_NAME, out)
}

/** What storage-api is running with, as far as Studio's own container environment can say. */
function envFileSizeLimit(): number {
  const raw = projectEnv('UPLOAD_FILE_SIZE_LIMIT')
  if (raw === undefined || raw === '') return DEFAULT_FILE_SIZE_LIMIT

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    warn(
      `UPLOAD_FILE_SIZE_LIMIT is not a positive integer (${raw}); reading it as the 50 MB default`
    )
    return DEFAULT_FILE_SIZE_LIMIT
  }
  return parsed
}

/** Off unless the environment says `true`, which is how storage-api reads it. */
const envImageTransformation = (): boolean => projectEnv('ENABLE_IMAGE_TRANSFORMATION') === 'true'

/** On unless the environment says `false`: `S3_PROTOCOL_ENABLED` defaults to true in storage-api. */
const envS3ProtocolEnabled = (): boolean => projectEnv('S3_PROTOCOL_ENABLED') !== 'false'

/**
 * The key pair the compose file gave storage-api, presented as the one credential the page lists.
 *
 * It has no creation time — the container environment carries none — so it is reported as created
 * now, which the table renders as "Today". The description is what tells the operator where it came
 * from.
 */
function envCredential(): StoredCredential | null {
  const access_key = projectEnv('S3_PROTOCOL_ACCESS_KEY_ID')
  const secret_key = projectEnv('S3_PROTOCOL_ACCESS_KEY_SECRET')
  if (!access_key || !secret_key) return null

  return {
    id: 'env',
    description: 'From container environment',
    access_key,
    secret_key,
    created_at: new Date().toISOString(),
  }
}

/** State wins per field; anything never saved comes from the mirrored container environment. */
function settingsFromState(state: StorageState): ResolvedSettings {
  return {
    fileSizeLimit: state.fileSizeLimit ?? envFileSizeLimit(),
    imageTransformation: state.imageTransformation ?? envImageTransformation(),
    s3ProtocolEnabled: state.s3ProtocolEnabled ?? envS3ProtocolEnabled(),
    credential: state.s3Credential === undefined ? envCredential() : state.s3Credential,
  }
}

const resolveSettings = async (): Promise<ResolvedSettings> => settingsFromState(await readState())

/**
 * Renders the file the storage container sources.
 *
 * `UPLOAD_FILE_SIZE_LIMIT_STANDARD` carries the same number: storage-api reads the first for
 * resumable uploads and the second for standard ones, and the settings page offers one limit.
 * `FILE_SIZE_LIMIT` is the third spelling of that number — the one upstream's own compose file uses
 * on the storage service (`docker/docker-compose.yml`), where a stack built from it rather than from
 * the Coolify template would otherwise keep its compose limit through every save.
 * `IMAGE_TRANSFORMATION_ENABLED` is the same flag under its other accepted name, written so the file
 * does not depend on which one the running version prefers.
 *
 * With no credential both S3 names are written empty rather than left out: the file has to override
 * the compose `environment:` the container also has, and an absent line would leave the old key in
 * place. storage-api reads an empty value as unset.
 */
async function renderStorageEnv(settings: ResolvedSettings): Promise<void> {
  const limit = String(settings.fileSizeLimit)
  const content = renderEnvFile({
    FILE_SIZE_LIMIT: limit,
    UPLOAD_FILE_SIZE_LIMIT: limit,
    UPLOAD_FILE_SIZE_LIMIT_STANDARD: limit,
    ENABLE_IMAGE_TRANSFORMATION: String(settings.imageTransformation),
    IMAGE_TRANSFORMATION_ENABLED: String(settings.imageTransformation),
    S3_PROTOCOL_ENABLED: String(settings.s3ProtocolEnabled),
    S3_PROTOCOL_ACCESS_KEY_ID: settings.credential?.access_key ?? '',
    S3_PROTOCOL_ACCESS_KEY_SECRET: settings.credential?.secret_key ?? '',
  })

  await writeEnvFile(content, getStorageConfigDir(), STORAGE_ENV_FILE_NAME)
}

/**
 * The shape the settings page and the S3 page both read.
 *
 * Everything outside `fileSizeLimit`, `imageTransformation` and `s3Protocol` is reported off and
 * zeroed: self-hosted storage has no Iceberg catalog, no vector buckets, no CDN to purge and no
 * object versioning, and the two pages read these fields to decide what to render.
 */
function toConfigResponse(settings: ResolvedSettings): StorageConfig {
  return {
    capabilities: { iceberg_catalog: false, list_v2: false, object_versioning: false },
    external: { upstreamTarget: 'main' },
    features: {
      icebergCatalog: { enabled: false, maxCatalogs: 0, maxNamespaces: 0, maxTables: 0 },
      imageTransformation: { enabled: settings.imageTransformation },
      purgeCache: { enabled: false },
      s3Protocol: { enabled: settings.s3ProtocolEnabled },
      vectorBuckets: { enabled: false, maxBuckets: 0, maxIndexes: 0 },
    },
    fileSizeLimit: settings.fileSizeLimit,
    // The platform reports which storage migration the tenant is on. Nothing here tracks that.
    migrationVersion: null,
  }
}

export async function getStorageConfig(): Promise<StorageConfig> {
  return toConfigResponse(await resolveSettings())
}

/** Top-level body keys this endpoint accepts. Anything else is refused rather than dropped. */
const ALLOWED_BODY_KEYS = ['fileSizeLimit', 'features', 'external'] as const

/**
 * Feature keys this endpoint accepts. The two it stores are the ones the pages edit; the other three
 * are accepted and discarded, because the S3 page sends `...config.features` — the whole object it
 * was given — with only `s3Protocol` replaced, so refusing them would refuse every S3 save.
 */
const STORED_FEATURE_KEYS = ['imageTransformation', 's3Protocol'] as const
const IGNORED_FEATURE_KEYS = ['icebergCatalog', 'purgeCache', 'vectorBuckets'] as const

function validateFileSizeLimit(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_FILE_SIZE_LIMIT
  ) {
    throw new ServiceConfigValidationError(
      `fileSizeLimit must be an integer between 1 and ${MAX_FILE_SIZE_LIMIT}`
    )
  }
  return value
}

function validateFeatureToggle(value: unknown, field: string): boolean {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') {
    throw new ServiceConfigValidationError(`features.${field} must be { enabled: boolean }`)
  }
  return value.enabled
}

/**
 * Merges a PATCH into what was saved and renders the file the operator's restart will pick up.
 *
 * The merge is per field, in both directions: the settings form sends `fileSizeLimit` plus
 * `imageTransformation` and `s3Protocol`, the S3 page sends `features` alone, and neither may undo
 * what the other saved.
 */
export async function updateStorageConfig(body: Record<string, unknown>): Promise<StorageConfig> {
  for (const key of Object.keys(body)) {
    if (!(ALLOWED_BODY_KEYS as readonly string[]).includes(key)) {
      throw new ServiceConfigValidationError(`${key} is not a storage setting`)
    }
  }

  const patch: StorageState = {}

  if (body.fileSizeLimit !== undefined && body.fileSizeLimit !== null) {
    patch.fileSizeLimit = validateFileSizeLimit(body.fileSizeLimit)
  }

  if (body.features !== undefined && body.features !== null) {
    const features = body.features
    if (!isRecord(features)) {
      throw new ServiceConfigValidationError('features must be an object')
    }

    for (const key of Object.keys(features)) {
      const known =
        (STORED_FEATURE_KEYS as readonly string[]).includes(key) ||
        (IGNORED_FEATURE_KEYS as readonly string[]).includes(key)
      if (!known) {
        throw new ServiceConfigValidationError(`features.${key} is not a storage setting`)
      }
    }

    if (features.imageTransformation !== undefined && features.imageTransformation !== null) {
      patch.imageTransformation = validateFeatureToggle(
        features.imageTransformation,
        'imageTransformation'
      )
    }

    if (features.s3Protocol !== undefined && features.s3Protocol !== null) {
      patch.s3ProtocolEnabled = validateFeatureToggle(features.s3Protocol, 's3Protocol')
    }
  }

  const state = await readState()
  const merged: StorageState = { ...state, ...patch }
  await writeState(merged)

  const settings = settingsFromState(merged)
  await renderStorageEnv(settings)

  return toConfigResponse(settings)
}

/** The list the S3 page renders. The secret is deliberately not in it — it is shown once, on create. */
export async function listCredentials(): Promise<{ data: StorageCredentialRow[] }> {
  const { credential } = await resolveSettings()
  if (credential === null) return { data: [] }

  return {
    data: [
      {
        id: credential.id,
        description: credential.description,
        created_at: credential.created_at,
        access_key: credential.access_key,
      },
    ],
  }
}

/**
 * `SB` then eighteen more, for twenty characters in all — the length of an AWS access key id, which
 * is what S3 clients and their validators expect to be handed.
 */
const ACCESS_KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const ACCESS_KEY_LENGTH = 20
const ACCESS_KEY_PREFIX = 'SB'

/**
 * Rejection sampling rather than a modulo: 256 is not a multiple of 36, so folding a byte into the
 * alphabet would make the first four letters likelier than the rest.
 */
function generateAccessKey(): string {
  let key = ACCESS_KEY_PREFIX
  const limit = 256 - (256 % ACCESS_KEY_ALPHABET.length)

  while (key.length < ACCESS_KEY_LENGTH) {
    for (const byte of randomBytes(ACCESS_KEY_LENGTH)) {
      if (byte >= limit) continue
      key += ACCESS_KEY_ALPHABET[byte % ACCESS_KEY_ALPHABET.length]
      if (key.length === ACCESS_KEY_LENGTH) break
    }
  }

  return key
}

/** Thirty bytes is exactly forty base64url characters, with no padding to strip. */
const generateSecretKey = (): string => randomBytes(30).toString('base64url')

/**
 * A label, not a document. The description is written into `storage-config.json` and rendered back
 * into the S3 page's table; nothing truncates it on the way, so the bound is here.
 */
const MAX_CREDENTIAL_DESCRIPTION_LENGTH = 200

/**
 * Issues the one S3 key pair this storage can hold.
 *
 * Single-tenant storage-api authenticates the S3 protocol against `S3_PROTOCOL_ACCESS_KEY_ID` and
 * `S3_PROTOCOL_ACCESS_KEY_SECRET` — one pair, from the environment. There is no table of keys to add
 * a second row to, so a second key would silently replace the first.
 *
 * The description is stored trimmed: it is what the table shows, and the surrounding whitespace of a
 * pasted name is not part of the name.
 */
export async function createCredential(
  description: unknown
): Promise<{ id: string; description: string; access_key: string; secret_key: string }> {
  if (typeof description !== 'string' || description.trim() === '') {
    throw new ServiceConfigValidationError('description must be a non-empty string')
  }

  const label = description.trim()
  if (label.length > MAX_CREDENTIAL_DESCRIPTION_LENGTH) {
    throw new ServiceConfigValidationError(
      `description must be at most ${MAX_CREDENTIAL_DESCRIPTION_LENGTH} characters`
    )
  }

  const state = await readState()
  const settings = settingsFromState(state)

  if (settings.credential !== null) {
    throw new ServiceConfigValidationError(
      'Self-hosted storage supports a single S3 access key; revoke the existing one first'
    )
  }

  const credential: StoredCredential = {
    id: randomUUID(),
    description: label,
    access_key: generateAccessKey(),
    secret_key: generateSecretKey(),
    created_at: new Date().toISOString(),
  }

  const merged: StorageState = { ...state, s3Credential: credential }
  await writeState(merged)
  await renderStorageEnv({ ...settings, credential })

  return {
    id: credential.id,
    description: credential.description,
    access_key: credential.access_key,
    secret_key: credential.secret_key,
  }
}

/**
 * Revokes the key pair, leaving the tombstone {@link StorageState} describes so the mirrored
 * environment cannot bring it back on the next read.
 */
export async function deleteCredential(id: string): Promise<void> {
  const state = await readState()
  const settings = settingsFromState(state)

  if (settings.credential === null || settings.credential.id !== id) {
    throw new ServiceConfigNotFoundError(`No S3 access key with id ${id}`)
  }

  const merged: StorageState = { ...state, s3Credential: null }
  await writeState(merged)
  await renderStorageEnv({ ...settings, credential: null })
}
