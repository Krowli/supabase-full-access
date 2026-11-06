import { isMap, isSeq, parseDocument, type YAMLMap } from 'yaml'

/** Bad input from the caller (an unknown variable, a malformed id or ref): the API answers 400. */
export class StackInputError extends Error {}
/** No such stack: 404. */
export class StackNotFoundError extends Error {}

/** A stack id: 24 lowercase letters and digits, the shape of a Coolify uuid. */
export const STACK_ID = /^[a-z0-9]{24}$/
/** A project ref: 20 lowercase letters (src/secrets.ts generateRef). */
export const PROJECT_REF = /^[a-z]{20}$/

/** The only variables a stack's .env may hold: the project secrets the template reads as ${NAME}. */
export const STACK_ENV_KEYS = [
  'PROJECT_DB_PASSWORD',
  'PROJECT_JWT_SECRET',
  'PROJECT_ANON_KEY',
  'PROJECT_SERVICE_KEY',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
] as const
// Passwords and S3 keys are alphanumeric, the keys are JWTs (base64url and dots): nothing that
// could break a .env line or start an interpolation.
const STACK_ENV_VALUE = /^[A-Za-z0-9._-]+$/

export type StackFiles = {
  /** compose.yaml of the compose project <id>, with ${...} still in it (filled from .env). */
  compose: string
  /** Files the stack binds, relative to the stack directory (the template's inline `content:`). */
  files: { path: string; content: string }[]
  /** The containers to attach to the shared network after every `up`, with their alias. */
  containers: string[]
}

/**
 * Turns the rendered project template (written for Coolify, deploy/platform/project-compose.yaml) into a
 * plain compose project named <id>, the way Coolify ran the stacks it made, so an existing stack is
 * taken over in place: container `<service>-<id>`, named volumes `<id>_<volume>`, the external network
 * `<id>`, restart unless-stopped. Inline `content:` mounts become files of the stack directory; the
 * Coolify-only `exclude_from_hc` goes.
 *
 * The shared network (where Kong, Supavisor and Realtime reach the project) is not in the compose
 * file: compose would give every container its short service name there too, and every project's
 * `supabase-db` would answer to the same name. The runner attaches each container itself, under its
 * full name only (Coolify does the same).
 */
/** What makes one stack differ from the template: src/runner/stacks.ts reads it from meta.json. */
export type StackOptions = {
  /** The database image, for a stack made on another Postgres major than the template's. */
  postgresImage?: string
  /** Whether the stack runs Edge Functions (services marked `x-platform-only-with: functions`). */
  functions?: boolean
}

export function buildStack(rendered: string, id: string, options: StackOptions = {}): StackFiles {
  if (!STACK_ID.test(id)) throw new StackInputError(`Invalid stack id ${id}`)
  const doc = parseDocument(rendered)
  const services = doc.get('services')
  if (!isMap(services)) throw new Error('The template has no services')

  const volumeKey = (name: string) => `${id}_${name}`
  const files: StackFiles['files'] = []
  const containers: string[] = []

  for (const pair of [...services.items]) {
    const name = String(pair.key)
    const svc = pair.value as YAMLMap
    if (!isMap(svc)) throw new Error(`Service ${name} is not a mapping`)
    const onlyWith = svc.get('x-platform-only-with')
    if (onlyWith !== undefined) {
      if (onlyWith !== 'functions') throw new Error(`Service ${name}: unknown x-platform-only-with`)
      if (!options.functions) {
        services.delete(pair.key)
        continue
      }
      svc.delete('x-platform-only-with')
    }
    if (name === 'supabase-db' && options.postgresImage) svc.set('image', options.postgresImage)
    svc.delete('exclude_from_hc')
    svc.delete('container_name')
    svc.delete('networks')
    const container = `${name}-${id}`
    containers.push(container)

    const volumes = svc.get('volumes')
    if (isSeq(volumes)) {
      volumes.items = volumes.items.map((item) => {
        if (isMap(item)) {
          const content = item.get('content')
          if (content !== undefined) {
            const source = String(item.get('source'))
            if (!source.startsWith('./') || source.includes('..'))
              throw new Error(`Inline file ${source} must be a ./ path inside the stack`)
            files.push({ path: source.slice(2), content: String(content) })
            item.delete('content')
          }
          return item
        }
        // `name:/path` of a named volume becomes `<id>_name:/path`; host paths stay.
        const text = String((item as { value?: unknown }).value ?? item)
        const [source, ...rest] = text.split(':')
        if (rest.length && /^[a-z0-9-]+$/.test(source)) {
          return doc.createNode([volumeKey(source), ...rest].join(':'))
        }
        return item
      })
    }

    svc.set('container_name', container)
    svc.set('restart', svc.get('restart') ?? 'unless-stopped')
    svc.set('networks', [id])
    svc.set('labels', {
      'supa.stack': id,
      'supa.service': name,
    })
  }

  const topVolumes = doc.get('volumes')
  if (isMap(topVolumes)) {
    const names = topVolumes.items.map((p) => String(p.key))
    doc.set('volumes', Object.fromEntries(names.map((n) => [volumeKey(n), { name: volumeKey(n) }])))
  }
  doc.set('networks', { [id]: { name: id, external: true } })

  return { compose: doc.toString({ lineWidth: 0 }), files, containers }
}

/** The stack's .env: only the known keys, only safe values. */
export function stackEnvFile(envs: Record<string, string>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(envs)) {
    if (!(STACK_ENV_KEYS as readonly string[]).includes(key))
      throw new StackInputError(`Unknown stack variable ${key}`)
    if (!STACK_ENV_VALUE.test(value))
      throw new StackInputError(`Stack variable ${key} has unsafe characters`)
    lines.push(`${key}=${value}`)
  }
  return lines.join('\n') + '\n'
}
