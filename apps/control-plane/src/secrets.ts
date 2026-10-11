import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from 'node:crypto'

const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const TEN_YEARS_S = 10 * 365 * 24 * 60 * 60

export type ProjectSecrets = {
  db_password: string
  jwt_secret: string
  anon_key: string
  service_key: string
  /** The project's MinIO access key, scoped to its own bucket (src/minio.ts). */
  s3_access_key: string
  s3_secret_key: string
}

export const SECRET_COLUMNS = [
  'db_password',
  'jwt_secret',
  'anon_key',
  'service_key',
  's3_access_key',
  's3_secret_key',
] as const

function randomString(alphabet: string, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)]
  return out
}

/** A project ref in the shape Supabase uses: 20 lowercase letters. */
export function generateRef(): string {
  return randomString(LOWER, 20)
}

/** Alphanumeric only, so it is safe inside connection URIs and compose env lines. */
export function generatePassword(length = 32): string {
  return randomString(ALNUM, length)
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url')

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

export function generateProjectSecrets(ref: string, now = new Date()): ProjectSecrets {
  const jwt_secret = generatePassword(48)
  const iat = Math.floor(now.getTime() / 1000)
  const key = (role: string) =>
    signJwt({ iss: 'supabase', ref, role, iat, exp: iat + TEN_YEARS_S }, jwt_secret)
  return {
    db_password: generatePassword(32),
    jwt_secret,
    anon_key: key('anon'),
    service_key: key('service_role'),
    // MinIO limits access keys to 20 characters and secret keys to 40.
    s3_access_key: randomString(UPPER_DIGITS, 20),
    s3_secret_key: generatePassword(40),
  }
}

/** PLATFORM_SECRETS_KEY: 32 bytes as 64 hex chars or base64. */
export function parseSecretsKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (key.length !== 32)
    throw new Error('PLATFORM_SECRETS_KEY must be 32 bytes (64 hex chars or base64)')
  return key
}

/**
 * AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, base64url. `context` (ref and column) is
 * bound as associated data, so a value copied to another row or column fails to decrypt.
 */
export function encrypt(plain: string, key: Buffer, context: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(context))
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', b64url(iv), b64url(cipher.getAuthTag()), b64url(ct)].join('.')
}

export function decrypt(sealed: string, key: Buffer, context: string): string {
  const [version, iv, tag, ct] = sealed.split('.')
  if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unknown secret format')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(context))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString(
    'utf8'
  )
}
