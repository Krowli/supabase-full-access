import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { projectEnv } from '../project-context'

/**
 * Studio's own record of the auth settings that were changed from the UI.
 *
 * GoTrue's config directory is not a source of truth we can read back: keys are sticky (removing a
 * line does not unset the value) and the running config mixes container env with every file in the
 * directory. So Studio keeps what it wrote here, and renders the env file from it.
 */
export const STATE_FILE_NAME = 'auth-config.json'

/** Flat `{ [platformKey]: value }` map, keyed by `GoTrueConfigResponse` property name. */
export type AuthConfigState = Record<string, unknown>

export function getStateDir(): string {
  return projectEnv('STUDIO_AUTH_STATE_DIR') ?? '/var/lib/studio'
}

/** Distinguishes concurrent writes, so two saves in flight cannot share one temp file. */
let tmpSequence = 0

/**
 * The shape a state file name may take. The name is joined onto a directory path, so anything
 * carrying a separator or a dot segment — or any extension other than `.json` — is refused rather
 * than read from or written to.
 */
const STATE_FILE_NAME_PATTERN = /^[a-z0-9-]+\.json$/

function assertStateFileName(fileName: string): void {
  if (!STATE_FILE_NAME_PATTERN.test(fileName)) {
    throw new Error(`invalid state file name: ${fileName}`)
  }
}

/**
 * Reads a JSON state file. A missing file is not an error — it means nothing has been changed from
 * the UI yet, and every setting falls back to its default or mirrored env value.
 *
 * Shared by the services that keep their own record of what the UI saved, because a running
 * service's own config is not a source of truth Studio can read back.
 */
export async function readJsonState(
  fileName: string,
  dir = getStateDir()
): Promise<Record<string, unknown>> {
  assertStateFileName(fileName)
  const path = join(dir, fileName)

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }

  const name = fileName.slice(0, -'.json'.length)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${name} state is not valid JSON: ${path}`)
  }

  // A JSON array, string or number parses fine but is not a state object.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} state is not valid JSON: ${path}`)
  }

  return parsed as Record<string, unknown>
}

/**
 * Writes a JSON state file atomically: a reader either sees the previous file or the new one, never
 * a half-written one. Mode 0600 because a state file holds SMTP passwords and OAuth secrets.
 */
export async function writeJsonState(
  fileName: string,
  state: Record<string, unknown>,
  dir = getStateDir()
): Promise<void> {
  assertStateFileName(fileName)
  await mkdir(dir, { recursive: true })

  tmpSequence += 1
  const tmpPath = join(dir, `${fileName}.tmp.${process.pid}.${tmpSequence}`)
  // `mode` only applies when the file is created, so chmod covers the case where it already exists.
  await writeFile(tmpPath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  await chmod(tmpPath, 0o600)
  await rename(tmpPath, join(dir, fileName))
}

/** The auth settings Studio saved. See {@link readJsonState}. */
export async function readState(dir = getStateDir()): Promise<AuthConfigState> {
  return await readJsonState(STATE_FILE_NAME, dir)
}

/** The auth settings Studio saved. See {@link writeJsonState}. */
export async function writeState(state: AuthConfigState, dir = getStateDir()): Promise<void> {
  await writeJsonState(STATE_FILE_NAME, state, dir)
}
