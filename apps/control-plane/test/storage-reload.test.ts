import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { loadTemplate, renderTemplate, templateValues } from '../src/template.ts'

// The project's storage-api reads Studio's storage.env only when it starts. Its command in
// project-compose.yaml runs it under a small loop that restarts it when that file changes, so a
// save in Studio applies by itself. This runs that very command, with a fake server.
const repo = resolve(import.meta.dirname, '../../..')
const template = loadTemplate(resolve(repo, 'deploy/platform/project-compose.yaml'))
const compose = parse(
  renderTemplate(
    template,
    templateValues('abcdefghijklmnopqrst', 'supa.example.com', {
      s3Endpoint: 'http://minio:9000',
      s3Region: 'us-east-1',
      imgproxyUrl: 'http://imgproxy:8080',
    }, '/data/platform/projects')
  )
) as { services: Record<string, { command: string[] }> }
const command = compose.services['supabase-storage'].command

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(50)
  }
}

let dir = ''
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

/** The compose command as the container's shell gets it, pointed at a temp dir and a fake server. */
function script(dir: string) {
  expect(command.slice(0, 2)).toEqual(['sh', '-c'])
  const body = command[2].replaceAll('$$', '$')
  expect(body).toContain('/etc/studio-config/storage.env')
  expect(body).toContain('node dist/start/server.js')
  expect(body).toMatch(/sleep 5\b/)
  const fake = `sh -c 'echo "start $FILE_SIZE_LIMIT" >> ${dir}/log; trap "echo stop >> ${dir}/log; exit 0" TERM; while :; do sleep 0.05; done'`
  return body
    .replaceAll('/etc/studio-config/storage.env', join(dir, 'storage.env'))
    .replaceAll('/tmp/storage-env-changed', join(dir, 'changed'))
    .replaceAll('exec node dist/start/server.js', `exec ${fake}`)
    .replaceAll('node dist/start/server.js', fake)
    .replace(/sleep 5\b/g, 'sleep 0.2')
}

const log = () =>
  readFileSync(join(dir, 'log'), 'utf8').trim().split('\n').map((line) => line.trim())

describe('storage-api restarts when Studio rewrites storage.env', () => {
  it('starts with the file, restarts on a change, stops cleanly on SIGTERM', async () => {
    dir = mkdtempSync(join(tmpdir(), 'storage-reload-'))
    writeFileSync(join(dir, 'log'), '')
    writeFileSync(join(dir, 'storage.env'), 'FILE_SIZE_LIMIT=1000\n')
    const child = spawn('sh', ['-c', script(dir)], { stdio: 'ignore' })
    try {
      await until(() => log().includes('start 1000'))

      await sleep(500)
      expect(log()).toEqual(['start 1000']) // unchanged file: no restart

      writeFileSync(join(dir, 'storage.env'), 'FILE_SIZE_LIMIT=2000\n')
      await until(() => log().includes('start 2000'))
      expect(log()).toEqual(['start 1000', 'stop', 'start 2000'])

      const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
      child.kill('SIGTERM')
      expect(await exited).toBe(0)
      expect(log()).toEqual(['start 1000', 'stop', 'start 2000', 'stop'])
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('starts without the file and picks it up once Studio writes it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'storage-reload-'))
    writeFileSync(join(dir, 'log'), '')
    const child = spawn('sh', ['-c', script(dir)], { stdio: 'ignore' })
    try {
      await until(() => log().includes('start'))
      writeFileSync(join(dir, 'storage.env'), 'FILE_SIZE_LIMIT=3000\n')
      await until(() => log().includes('start 3000'))
      expect(log()).toEqual(['start', 'stop', 'start 3000'])
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('kills a storage-api that lingers after SIGTERM, so the new one starts', async () => {
    // storage-api logs "Shutdown successfully" at once but its process stays up to a minute.
    dir = mkdtempSync(join(tmpdir(), 'storage-reload-'))
    writeFileSync(join(dir, 'log'), '')
    writeFileSync(join(dir, 'storage.env'), 'FILE_SIZE_LIMIT=1000\n')
    const lingering = `sh -c 'echo "start $FILE_SIZE_LIMIT" >> ${dir}/log; trap "echo stop >> ${dir}/log" TERM; while :; do sleep 0.05; done'`
    const body = script(dir).replaceAll(/exec sh -c '[^']*'/g, `exec ${lingering}`)
    const child = spawn('sh', ['-c', body], { stdio: 'ignore' })
    try {
      await until(() => log().includes('start 1000'))
      writeFileSync(join(dir, 'storage.env'), 'FILE_SIZE_LIMIT=2000\n')
      await until(() => log().includes('start 2000'))
      expect(log()).toEqual(['start 1000', 'stop', 'start 2000'])
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('exits when storage-api itself dies, so Docker restarts the container', async () => {
    dir = mkdtempSync(join(tmpdir(), 'storage-reload-'))
    writeFileSync(join(dir, 'storage.env'), 'FILE_SIZE_LIMIT=1\n')
    const body = script(dir).replaceAll(
      /exec sh -c '[^']*'|sh -c '[^']*'/g,
      `sh -c 'exit 3'`
    )
    const child = spawn('sh', ['-c', body], { stdio: 'ignore' })
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)))
    expect(code).toBe(3)
  })
})
