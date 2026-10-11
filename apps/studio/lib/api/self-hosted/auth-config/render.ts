import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { projectEnv } from '../project-context'

/**
 * GoTrue reads every `*.env` file in its config directory in name order, and files there override
 * the container env. The `99_` prefix puts Studio's file last, so what the UI writes wins.
 */
export const ENV_FILE_NAME = '99_studio.env'

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/

export function getConfigDir(): string {
  return projectEnv('GOTRUE_CONFIG_DIR') ?? '/etc/gotrue'
}

/** Distinguishes concurrent writes, so two saves in flight cannot share one temp file. */
let tmpSequence = 0

/**
 * Backslash first — escaping it after the others would double-escape what they inserted.
 *
 * One case this gets wrong, knowingly: a backslash typed directly before a `$` is doubled here, and
 * godotenv unescapes the pair back to `\$` (`unescapeCharsRegex` skips a `$`,
 * `internal/forks/godotenv/parser.go:254`), which `expandVariables` at line 257 then reads as an
 * escaped dollar and strips the backslash from. Nothing the UI writes carries that pair, and that
 * fork substitutes no variable values at all, so the loss is a cosmetic one.
 */
function escapeValue(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
}

/**
 * Renders `{ ENV_NAME: value }` as the file GoTrue reads. Keys are sorted so the same settings
 * always produce the same bytes, which keeps a no-op save from touching the file GoTrue watches.
 */
export function renderEnvFile(map: Record<string, string>): string {
  const keys = Object.keys(map).sort()

  for (const key of keys) {
    if (!ENV_KEY.test(key)) {
      throw new Error(`auth-config env key is not a valid environment variable name: ${key}`)
    }
  }

  return keys.map((key) => `${key}="${escapeValue(map[key])}"\n`).join('')
}

/**
 * Writes the env file atomically. GoTrue watches `*.env` in this directory and reloads on change,
 * so the partial write lands under a `.tmp` name it ignores and only the rename is observable.
 *
 * `fileName` is for the other self-hosted settings pages: Storage renders one file of its own name
 * (`storage.env`) into its own directory, and the atomic rename and the mode are the same either
 * way, so the name is the only thing that differs.
 */
export async function writeEnvFile(
  content: string,
  dir: string,
  fileName = ENV_FILE_NAME
): Promise<void> {
  await mkdir(dir, { recursive: true })

  tmpSequence += 1
  const tmpPath = join(dir, `${fileName}.tmp.${process.pid}.${tmpSequence}`)
  // `mode` only applies when the file is created, so chmod covers the case where it already exists.
  await writeFile(tmpPath, content, { mode: 0o644 })
  await chmod(tmpPath, 0o644)
  await rename(tmpPath, join(dir, fileName))
}
