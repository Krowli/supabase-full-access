import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { StackInputError } from './stack.ts'

/**
 * A project's Edge Functions as the runner receives them: the files of its functions folder (what
 * `supabase/functions` holds in an app's repo, `_shared` included) and verify_jwt per function (the
 * repo's config.toml `[functions.<name>] verify_jwt`). A function not listed verifies the JWT.
 */
export type FunctionsBundle = { files: Record<string, string>; verify_jwt: Record<string, boolean> }

/** A function: a top-level folder whose name starts with a letter or digit (the router agrees). */
export const FUNCTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
// Path segments start with a letter, digit or underscore: no `..`, no hidden files, no absolute paths.
const FILE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*){0,7}$/
const MAX_FILES = 500
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024

// Names the platform sets itself or the router keeps for itself; the platform refuses SUPABASE_ too.
const RESERVED_SECRET = /^(SUPABASE_|DENO_|EDGE_RUNTIME_)|^(JWT_SECRET|VERIFY_JWT|PATH|HOME|HOSTNAME)$/
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const MAX_SECRETS = 200
const MAX_SECRET_BYTES = 32 * 1024

export function functionNames(files: Record<string, string>): string[] {
  const names = new Set<string>()
  for (const path of Object.keys(files)) {
    const top = path.split('/')[0]
    if (path.includes('/') && FUNCTION_NAME.test(top)) names.add(top)
  }
  return [...names].sort()
}

export function checkBundle(input: { files?: unknown; verify_jwt?: unknown }): FunctionsBundle {
  const { files, verify_jwt = {} } = input
  if (typeof files !== 'object' || files === null || Array.isArray(files))
    throw new StackInputError('files must be an object of path → text')
  const entries = Object.entries(files)
  if (!entries.length) throw new StackInputError('No files')
  if (entries.length > MAX_FILES) throw new StackInputError(`More than ${MAX_FILES} files`)
  let bytes = 0
  for (const [path, text] of entries) {
    if (!FILE_PATH.test(path)) throw new StackInputError(`Invalid file path ${JSON.stringify(path)}`)
    if (typeof text !== 'string') throw new StackInputError(`File ${path} is not text`)
    bytes += Buffer.byteLength(text)
  }
  if (bytes > MAX_BUNDLE_BYTES) throw new StackInputError('The functions are larger than 2 MB')
  const names = functionNames(files as Record<string, string>)
  if (!names.length) throw new StackInputError('No function folder (<name>/index.ts)')
  if (typeof verify_jwt !== 'object' || verify_jwt === null || Array.isArray(verify_jwt))
    throw new StackInputError('verify_jwt must be an object of function → boolean')
  for (const [name, value] of Object.entries(verify_jwt)) {
    if (!names.includes(name)) throw new StackInputError(`verify_jwt names ${name}, not a function here`)
    if (typeof value !== 'boolean') throw new StackInputError(`verify_jwt.${name} is not a boolean`)
  }
  return { files: files as Record<string, string>, verify_jwt: verify_jwt as Record<string, boolean> }
}

export function checkSecrets(input: unknown): Record<string, string> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new StackInputError('secrets must be an object of NAME → value')
  const entries = Object.entries(input)
  if (entries.length > MAX_SECRETS) throw new StackInputError(`More than ${MAX_SECRETS} secrets`)
  for (const [name, value] of entries) {
    if (!SECRET_NAME.test(name)) throw new StackInputError(`Invalid secret name ${name}`)
    if (RESERVED_SECRET.test(name)) throw new StackInputError(`Secret name ${name} is reserved`)
    if (typeof value !== 'string') throw new StackInputError(`Secret ${name} is not a string`)
    // One line each in functions.env (compose reads it raw: no quotes, no interpolation).
    if (/[\r\n\0]/.test(value)) throw new StackInputError(`Secret ${name} spans lines`)
    if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new StackInputError(`Secret ${name} is too long`)
  }
  return input as Record<string, string>
}

export function secretsFile(secrets: Record<string, string>): string {
  return Object.entries(secrets)
    .map(([name, value]) => `${name}=${value}\n`)
    .join('')
}

/**
 * Replaces `<stackDir>/functions` with the bundle, whole: written beside it first, so the router never
 * sees half a deploy, and a function left out of the bundle is gone.
 */
export async function writeBundle(stackDir: string, bundle: FunctionsBundle): Promise<void> {
  const target = join(stackDir, 'functions')
  const next = `${target}.new`
  const old = `${target}.old`
  await rm(next, { recursive: true, force: true })
  for (const [path, text] of Object.entries(bundle.files)) {
    await mkdir(dirname(join(next, path)), { recursive: true })
    await writeFile(join(next, path), text)
  }
  await writeFile(join(next, '.platform.json'), JSON.stringify({ verify_jwt: bundle.verify_jwt }))
  await rm(old, { recursive: true, force: true })
  await rename(target, old).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err
  })
  await rename(next, target)
  await rm(old, { recursive: true, force: true })
}
