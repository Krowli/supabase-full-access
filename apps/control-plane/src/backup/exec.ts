// Runs the backup tools (restic, pg_dump, pg_restore, psql, mc). Secrets go in through the
// environment only, never as arguments (visible in `ps`), and nothing a tool prints is logged:
// callers keep only what they parse, and error messages are cut short.

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'

export type ExecResult = { code: number; stdout: string; stderr: string }

export type ExecOptions = {
  env?: Record<string, string>
  /** Written to the tool's stdin. */
  input?: string
  /** Send stdout to this file instead of keeping it (dumps). */
  stdoutFile?: string
  timeoutMs?: number
}

export type Exec = (cmd: string, args: string[], options?: ExecOptions) => Promise<ExecResult>

const MAX_KEPT = 4 * 1024 * 1024

export const exec: Exec = (cmd, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let written: Promise<void> = Promise.resolve()
    if (options.stdoutFile) {
      const file = createWriteStream(options.stdoutFile, { mode: 0o600 })
      written = new Promise((done, fail) => file.on('finish', done).on('error', fail))
      child.stdout.pipe(file)
    } else {
      child.stdout.on('data', (d: Buffer) => {
        if (stdout.length < MAX_KEPT) stdout += d.toString()
      })
    }
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_KEPT) stderr += d.toString()
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 6 * 60 * 60 * 1000)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      written.then(() => resolve({ code: code ?? -1, stdout, stderr }), reject)
    })
    child.stdin.end(options.input ?? '')
  })

/** The last meaningful line of a tool's error output, short enough for a status line. */
export function lastError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return (lines.at(-1) ?? 'no error output').slice(0, 300)
}

export async function must(exec: Exec, what: string, cmd: string, args: string[], options?: ExecOptions) {
  const r = await exec(cmd, args, options)
  if (r.code !== 0) throw new Error(`${what}: ${lastError(r.stderr)}`)
  return r
}
