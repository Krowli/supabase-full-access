// What to back up where (deploy/platform/SPEC.md §19). The owner keeps this file in the infra
// repository (SOPS); the infra sync puts it into the platform's Coolify env as BACKUP_CONFIG,
// and the backup service reads it from there before every run (src/backup/service.ts).
//
//   destinations:          where backups can go; S3-compatible storage (R2, AWS, Backblaze, MinIO, ...)
//     r2-main: { type: s3, endpoint, bucket, prefix?, region?, access_key_id, secret_access_key }
//   default:               for every project without an entry below
//     destination: r2-main
//     schedule: "02:30"    # daily, UTC
//     keep: { daily: 7, weekly: 4, monthly: 6 }
//   projects:              per project, by its name in Studio or its ref
//     taxroam: { destination?, schedule?, keep?, password?, enabled? }
//   encryption_key: ...    # each project's backups are encrypted with a password derived from it
//                          # (derivePassword) unless the project sets its own `password`
//
// Each project is one restic repository, <bucket>/<prefix>/<ref>; the platform's own database
// (the project registry) is the repository `_platform`.

import { createHmac } from 'node:crypto'

import { parse as parseYaml } from 'yaml'

export type Keep = { daily: number; weekly: number; monthly: number }

export type S3Destination = {
  type: 's3'
  endpoint: string
  bucket: string
  prefix?: string
  region?: string
  access_key_id: string
  secret_access_key: string
}

export type Destination = S3Destination

export type ProjectEntry = {
  destination?: string
  schedule?: string
  keep?: Partial<Keep>
  password?: string
  enabled?: boolean
}

export type BackupConfig = {
  destinations: Record<string, Destination>
  default: { destination: string; schedule: string; keep: Keep }
  projects: Record<string, ProjectEntry>
  encryption_key: string
}

export type Policy = {
  enabled: boolean
  destinationName: string
  destination: Destination
  schedule: string
  keep: Keep
  password: string
  repository: string
}

/** The repository id of the platform's own database. */
export const PLATFORM_REPOSITORY = '_platform'

const DEFAULT_SCHEDULE = '02:30'
const DEFAULT_KEEP: Keep = { daily: 7, weekly: 4, monthly: 6 }
const SCHEDULE = /^([01]\d|2[0-3]):[0-5]\d$/
const NAME = /^[A-Za-z0-9_.-]{1,64}$/
const PREFIX = /^[A-Za-z0-9_.\-/]{1,200}$/

class ConfigError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// Messages name keys and paths, never values: the file holds secrets.
function fail(path: string, problem: string): never {
  throw new ConfigError(`Backup config: ${path} ${problem}`)
}

function str(obj: Record<string, unknown>, key: string, path: string, required = true): string | undefined {
  const v = obj[key]
  if (v === undefined || v === null || v === '') {
    if (required) fail(`${path}.${key}`, 'is required')
    return undefined
  }
  if (typeof v !== 'string') fail(`${path}.${key}`, 'must be a string')
  return v
}

function keep(v: unknown, path: string): Partial<Keep> {
  if (v === undefined) return {}
  if (!isObject(v)) fail(path, 'must be a mapping of daily/weekly/monthly')
  const out: Partial<Keep> = {}
  for (const [k, n] of Object.entries(v)) {
    if (!['daily', 'weekly', 'monthly'].includes(k)) fail(`${path}.${k}`, 'is not daily, weekly or monthly')
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1000)
      fail(`${path}.${k}`, 'must be a whole number from 0 to 1000')
    out[k as keyof Keep] = n
  }
  return out
}

function schedule(v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'string' || !SCHEDULE.test(v)) fail(path, 'must be "HH:MM" (UTC)')
  return v
}

function destination(name: string, v: unknown): Destination {
  const path = `destinations.${name}`
  if (!NAME.test(name)) fail(path, 'has an invalid name (letters, digits, _ . -)')
  if (!isObject(v)) fail(path, 'must be a mapping')
  if (v.type !== 's3') fail(`${path}.type`, 'must be s3')
  const endpoint = str(v, 'endpoint', path)!.replace(/\/+$/, '')
  if (!/^https?:\/\/[^/\s]+(\/[^\s]*)?$/.test(endpoint)) fail(`${path}.endpoint`, 'must be an http(s) URL')
  const bucket = str(v, 'bucket', path)!
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket)) fail(`${path}.bucket`, 'is not a valid bucket name')
  const prefix = str(v, 'prefix', path, false)?.replace(/^\/+|\/+$/g, '')
  if (prefix !== undefined && (!PREFIX.test(prefix) || prefix.includes('..')))
    fail(`${path}.prefix`, 'has invalid characters')
  const region = str(v, 'region', path, false)
  return {
    type: 's3',
    endpoint,
    bucket,
    ...(prefix ? { prefix } : {}),
    ...(region ? { region } : {}),
    access_key_id: str(v, 'access_key_id', path)!,
    secret_access_key: str(v, 'secret_access_key', path)!,
  }
}

function decode(raw: string): unknown {
  const text = raw.trim()
  // base64 of the file (what the infra sync stores, so no character can upset an env file).
  if (/^[A-Za-z0-9+/=\s]+$/.test(text) && !/^\d+$/.test(text) && text.length % 4 === 0) {
    const decoded = Buffer.from(text, 'base64').toString('utf8')
    if (/^\s*[{a-z#]/i.test(decoded)) return parseYaml(decoded)
  }
  return parseYaml(text)
}

export function parseBackupConfig(raw: string): BackupConfig {
  let doc: unknown
  try {
    doc = decode(raw)
  } catch {
    fail('file', 'is not valid YAML or JSON')
  }
  if (!isObject(doc)) fail('file', 'must be a mapping')

  if (!isObject(doc.destinations) || Object.keys(doc.destinations).length === 0)
    fail('destinations', 'must list at least one destination')
  const destinations: Record<string, Destination> = {}
  for (const [name, d] of Object.entries(doc.destinations)) destinations[name] = destination(name, d)

  const known = (name: string | undefined, path: string) => {
    if (name !== undefined && !Object.hasOwn(destinations, name))
      fail(path, `names destination "${name}", which is not under destinations`)
  }

  const def = isObject(doc.default) ? doc.default : fail('default', 'must be a mapping')
  const defaultDestination = str(def, 'destination', 'default')!
  known(defaultDestination, 'default.destination')

  const encryption_key = str(doc, 'encryption_key', 'file')!
  if (encryption_key.length < 32) fail('encryption_key', 'must be at least 32 characters')

  const projects: Record<string, ProjectEntry> = {}
  if (doc.projects !== undefined && doc.projects !== null) {
    if (!isObject(doc.projects)) fail('projects', 'must be a mapping')
    for (const [name, entry] of Object.entries(doc.projects)) {
      const path = `projects.${name}`
      if (!NAME.test(name)) fail(path, 'has an invalid name')
      const e = entry ?? {}
      if (!isObject(e)) fail(path, 'must be a mapping')
      const dest = str(e, 'destination', path, false)
      known(dest, `${path}.destination`)
      const password = str(e, 'password', path, false)
      if (password !== undefined && password.length < 16) fail(`${path}.password`, 'must be at least 16 characters')
      if (e.enabled !== undefined && typeof e.enabled !== 'boolean') fail(`${path}.enabled`, 'must be true or false')
      projects[name] = {
        ...(dest ? { destination: dest } : {}),
        ...(e.schedule !== undefined ? { schedule: schedule(e.schedule, `${path}.schedule`) } : {}),
        ...(e.keep !== undefined ? { keep: keep(e.keep, `${path}.keep`) } : {}),
        ...(password ? { password } : {}),
        ...(e.enabled !== undefined ? { enabled: e.enabled as boolean } : {}),
      }
    }
  }

  return {
    destinations,
    default: {
      destination: defaultDestination,
      schedule: schedule(def.schedule, 'default.schedule') ?? DEFAULT_SCHEDULE,
      keep: { ...DEFAULT_KEEP, ...keep(def.keep, 'default.keep') },
    },
    projects,
    encryption_key,
  }
}

/** A project's own encryption password: one key in the infra file, a different password per project. */
export function derivePassword(encryptionKey: string, ref: string): string {
  return createHmac('sha256', encryptionKey).update(`restic:${ref}`).digest('hex')
}

export function repositoryUrl(d: Destination, id: string): string {
  const path = [d.bucket, d.prefix, id].filter(Boolean).join('/')
  return `s3:${d.endpoint}/${path}`
}

export function resolvePolicy(config: BackupConfig, project: { ref: string; name: string }): Policy {
  const entry = config.projects[project.ref] ?? config.projects[project.name] ?? {}
  const destinationName = entry.destination ?? config.default.destination
  const destination = config.destinations[destinationName]
  return {
    enabled: entry.enabled ?? true,
    destinationName,
    destination,
    schedule: entry.schedule ?? config.default.schedule,
    keep: { ...config.default.keep, ...entry.keep },
    password: entry.password ?? derivePassword(config.encryption_key, project.ref),
    repository: repositoryUrl(destination, project.ref),
  }
}

export function resticEnv(d: Destination, password: string): Record<string, string> {
  return {
    RESTIC_PASSWORD: password,
    AWS_ACCESS_KEY_ID: d.access_key_id,
    AWS_SECRET_ACCESS_KEY: d.secret_access_key,
    AWS_DEFAULT_REGION: d.region ?? 'auto',
  }
}

export function forgetArgs(k: Keep): string[] {
  const out: string[] = []
  if (k.daily) out.push('--keep-daily', String(k.daily))
  if (k.weekly) out.push('--keep-weekly', String(k.weekly))
  if (k.monthly) out.push('--keep-monthly', String(k.monthly))
  return out
}
