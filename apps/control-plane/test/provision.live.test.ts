/**
 * Live test against the real Coolify and server B. Run by hand, never in CI:
 *
 *   npm run test:live
 *
 * Needs: Docker on this machine (throwaway registry Postgres), ~/.coolify-token, and SSH to
 * server B through the jump host. It creates a Coolify project "Tests" with an environment
 * "control-plane", provisions one project stack at a time (B has ~3 GB free), and removes
 * everything at the end, including the Coolify project. Secrets are never printed.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createCoolifyClient, type Coolify, type CoolifyConfig } from '../src/coolify.ts'
import { Provisioner } from '../src/provisioner.ts'
import { createPgRegistry, migrate, type Registry } from '../src/registry.ts'
import { generatePassword } from '../src/secrets.ts'
import { loadTemplate, renderTemplate, serviceEnvs, templateValues } from '../src/template.ts'

const run = promisify(execFile)
const COOLIFY_URL = 'https://coolify-admin.example.com/api/v1'
const SERVER_UUID = 'l6kmhkc8cr107te5xkqs9ese' // db-b
const SSH = ['-o', 'BatchMode=yes', '-J', 'root@203.0.113.10', 'root@10.10.0.1']
const DOMAIN = 'supa.example.com'
const HEALTH_TIMEOUT_S = 600
const PG_CONTAINER = 'cp-live-registry'
const PG_PORT = 54330
const API_PORT = 18080
const STORAGE = { backend: 'file' } as const // shared MinIO arrives in M5

const token = readFileSync(resolve(homedir(), '.coolify-token'), 'utf8').trim()
const pgPassword = generatePassword()
const apiToken = generatePassword()
const secretsKey = generatePassword(32) // 32 ASCII chars, passed as base64 below
const secretsKeyB64 = Buffer.from(secretsKey).toString('base64')
const registryUrl = `postgres://postgres:${pgPassword}@127.0.0.1:${PG_PORT}/postgres`

const log = (msg: string, fields: Record<string, unknown> = {}) =>
  console.log(`[live] ${msg} ${Object.keys(fields).length ? JSON.stringify(fields) : ''}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const seconds = (since: number) => Math.round((Date.now() - since) / 1000)

async function coolifyApi<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: T }> {
  const res = await fetch(COOLIFY_URL + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T }
}

/** Runs a command on server B; `input` goes to stdin (used for headers, so keys stay off argv). */
async function onB(command: string, input?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ssh', [...SSH, command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) =>
      code === 0
        ? resolvePromise(out.trim())
        : reject(new Error(`ssh exit ${code}: ${err.slice(0, 300)}`))
    )
    child.stdin.end(input ?? '')
  })
}

/** HTTP status of a request made from inside the `coolify` network on server B. */
function curlOnB(url: string, apiKey?: string): Promise<string> {
  const config = apiKey
    ? `header = "apikey: ${apiKey}"\nheader = "Authorization: Bearer ${apiKey}"\n`
    : ''
  return onB(
    `docker run --rm -i --network coolify curlimages/curl:8.10.1 -K - -s -o /dev/null -w '%{http_code}' --max-time 10 ${url}`,
    config
  )
}

async function dockerLeftovers(uuid: string) {
  const out = await onB(
    `echo "$(docker ps -a -q --filter name=${uuid} | wc -l) $(docker volume ls -q | grep -c ${uuid} || true) $(docker network ls -q --filter name=${uuid} | wc -l)"`
  )
  const [containers, volumes, networks] = out.split(/\s+/).map(Number)
  return { containers, volumes, networks }
}

async function waitDockerClean(uuid: string) {
  const start = Date.now()
  for (;;) {
    const left = await dockerLeftovers(uuid)
    if (left.containers === 0 && left.volumes === 0 && left.networks === 0) return seconds(start)
    if (seconds(start) > 180) throw new Error(`Leftovers on B for ${uuid}: ${JSON.stringify(left)}`)
    await sleep(5000)
  }
}

let projectUuid = ''
let pool: pg.Pool
let registry: Registry
let coolifyConfig: CoolifyConfig
let server: ChildProcess | null = null
const results: Record<string, unknown> = {}

function startServer(): Promise<void> {
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PORT: String(API_PORT),
      COOLIFY_URL,
      COOLIFY_TOKEN: token,
      COOLIFY_PROJECT_UUID: projectUuid,
      COOLIFY_ENVIRONMENT: 'control-plane',
      COOLIFY_SERVER_UUID: SERVER_UUID,
      REGISTRY_DATABASE_URL: registryUrl,
      PLATFORM_SECRETS_KEY: secretsKeyB64,
      CONTROL_PLANE_TOKEN: apiToken,
      PROJECT_DOMAIN_SUFFIX: DOMAIN,
      PROJECT_STORAGE_BACKEND: 'file',
      PROVISION_TIMEOUT_SECONDS: String(HEALTH_TIMEOUT_S),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server = child
  return new Promise((resolvePromise, reject) => {
    child.stdout!.on('data', (d: Buffer) => {
      for (const line of d.toString().trim().split('\n')) {
        console.log(`[server] ${line}`)
        if (line.includes('server.listening')) resolvePromise()
      }
    })
    child.stderr!.on('data', (d: Buffer) => console.error(`[server] ${d.toString().trim()}`))
    child.on('exit', (code) => reject(new Error(`server exited early with ${code}`)))
  })
}

function killServer(signal: NodeJS.Signals) {
  server?.kill(signal)
  server = null
}

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
  })
  return { status: res.status, body: await res.json() }
}

async function servicesNamed(ref: string): Promise<string[]> {
  const { data } = await coolifyApi<{ services: { uuid: string; name: string }[] }>(
    'GET',
    `/projects/${projectUuid}/control-plane`
  )
  return data.services.filter((s) => s.name === ref).map((s) => s.uuid)
}

async function checkStack(ref: string, uuid: string) {
  const secrets = (await registry.getSecrets(ref))!
  const checks = {
    rest_with_anon_key: await curlOnB(`http://supabase-rest-${uuid}:3000/`, secrets.anon_key),
    rest_with_foreign_key: await curlOnB(
      `http://supabase-rest-${uuid}:3000/`,
      // A well-formed key signed with a different secret must be rejected.
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJlLWZyb20tZWxzZXdoZXJl'
    ),
    auth_health: await curlOnB(`http://supabase-auth-${uuid}:9999/health`),
    storage_buckets_with_service_key: await curlOnB(
      `http://supabase-storage-${uuid}:5000/bucket`,
      secrets.service_key
    ),
  }
  log('stack checks from the coolify network on B', { ref, ...checks })
  expect(checks).toEqual({
    rest_with_anon_key: '200',
    rest_with_foreign_key: '401',
    auth_health: '200',
    storage_buckets_with_service_key: '200',
  })
  return checks
}

async function deleteAndVerify(ref: string, uuid: string, via: 'http' | Provisioner) {
  const before = await dockerLeftovers(uuid)
  log('before delete, resources on B', { ref, ...before })
  expect(before.containers).toBe(4)
  if (via === 'http') expect((await api(`/projects/${ref}`, { method: 'DELETE' })).status).toBe(200)
  else await via.delete(ref)
  expect(await registry.get(ref)).toBeNull()
  expect(await registry.getSecrets(ref)).toBeNull()
  expect((await coolifyApi('GET', `/services/${uuid}`)).status).toBe(404)
  const cleanS = await waitDockerClean(uuid)
  log('after delete, B has no containers, volumes or networks', { ref, uuid, seconds: cleanS })
  return cleanS
}

beforeAll(async () => {
  await run('docker', ['rm', '-f', PG_CONTAINER]).catch(() => {})
  await run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    PG_CONTAINER,
    '-e',
    `POSTGRES_PASSWORD=${pgPassword}`,
    '-p',
    `127.0.0.1:${PG_PORT}:5432`,
    'postgres:17-alpine',
  ])
  pool = new pg.Pool({ connectionString: registryUrl })
  for (let i = 0; ; i++) {
    try {
      await pool.query('select 1')
      break
    } catch (err) {
      if (i > 30) throw err
      await sleep(1000)
    }
  }
  await migrate(pool)
  registry = createPgRegistry(pool, Buffer.from(secretsKey))

  const project = await coolifyApi<{ uuid: string }>('POST', '/projects', {
    name: 'Tests',
    description: 'apps/control-plane live test, deleted when the test ends',
  })
  expect(project.status).toBe(201)
  projectUuid = project.data.uuid
  expect(
    (await coolifyApi('POST', `/projects/${projectUuid}/environments`, { name: 'control-plane' }))
      .status
  ).toBe(201)
  coolifyConfig = {
    url: COOLIFY_URL,
    token,
    projectUuid,
    environment: 'control-plane',
    serverUuid: SERVER_UUID,
  }
  log('setup done', { coolify_project: projectUuid })
}, 120_000)

afterAll(async () => {
  killServer('SIGKILL')
  // Anything a failed test left behind goes first, then the Coolify project, then local Postgres.
  if (registry && projectUuid) {
    const cleanup = new Provisioner({
      registry,
      coolify: createCoolifyClient(coolifyConfig),
      renderCompose: () => '',
      serviceEnvs: () => ({}),
      healthTimeoutMs: 0,
      pollIntervalMs: 0,
    })
    for (const p of await registry.list()) {
      log('cleanup: deleting leftover project', { ref: p.ref })
      await cleanup
        .delete(p.ref)
        .catch((e) => log('cleanup failed', { ref: p.ref, error: String(e) }))
      if (p.coolify_service_uuid) await waitDockerClean(p.coolify_service_uuid).catch(() => {})
    }
  }
  if (projectUuid) {
    const env = await coolifyApi<{ services: { uuid: string }[] }>(
      'GET',
      `/projects/${projectUuid}/control-plane`
    )
    for (const s of env.data?.services ?? []) {
      log('cleanup: deleting leftover Coolify service', { uuid: s.uuid })
      await coolifyApi(
        'DELETE',
        `/services/${s.uuid}?delete_configurations=true&delete_volumes=true&docker_cleanup=true&delete_connected_networks=true`
      )
      await waitDockerClean(s.uuid).catch(() => {})
    }
    const del = await coolifyApi('DELETE', `/projects/${projectUuid}`)
    log('Coolify project deleted', { status: del.status })
  }
  await pool?.end()
  await run('docker', ['rm', '-f', PG_CONTAINER]).catch(() => {})
  log('RESULTS', results)
}, 600_000)

describe('control plane against the real Coolify', () => {
  it('HTTP: create reaches ACTIVE_HEALTHY, the stack answers on the coolify network, delete cleans up', async () => {
    await startServer()
    const t0 = Date.now()
    const created = await api('/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'live clean create' }),
    })
    expect(created.status).toBe(201)
    const ref: string = created.body.ref
    const seen: string[] = []
    let project
    for (;;) {
      project = (await api(`/projects/${ref}`)).body
      if (seen.at(-1) !== project.status) seen.push(project.status)
      if (project.status === 'ACTIVE_HEALTHY' || project.status === 'FAILED') break
      if (seconds(t0) > HEALTH_TIMEOUT_S + 60) throw new Error('timed out')
      await sleep(2000)
    }
    const healthyS = seconds(t0)
    log('clean create finished', {
      ref,
      status: project.status,
      seconds: healthyS,
      statuses: seen,
      error: project.last_error,
    })
    expect(project.status).toBe('ACTIVE_HEALTHY')
    expect(seen).toContain('COMING_UP')
    const uuid = project.coolify_service_uuid
    expect(await servicesNamed(ref)).toEqual([uuid])

    const checks = await checkStack(ref, uuid)
    const cleanupS = await deleteAndVerify(ref, uuid, 'http')
    killServer('SIGTERM')
    results.clean_create = {
      seconds_to_healthy: healthyS,
      statuses: seen,
      checks,
      seconds_until_docker_clean: cleanupS,
    }
  }, 1_200_000)

  it('HTTP: the process is killed after the Coolify service exists; a re-run finishes without a duplicate', async () => {
    await startServer()
    const t0 = Date.now()
    const ref: string = (
      await api('/projects', { method: 'POST', body: JSON.stringify({ name: 'live kill' }) })
    ).body.ref
    let uuid: string | null = null
    while (!uuid) {
      uuid = (await registry.get(ref))!.coolify_service_uuid
      if (seconds(t0) > 120) throw new Error('service never created')
      if (!uuid) await sleep(50)
    }
    killServer('SIGKILL')
    const atKill = await registry.get(ref)
    const coolifyAtKill = await coolifyApi<{ status: string }>('GET', `/services/${uuid}`)
    log('killed the server', {
      ref,
      uuid,
      registry_status: atKill!.status,
      coolify_status: coolifyAtKill.data.status,
    })
    expect(atKill!.status).toBe('CREATING')
    expect(coolifyAtKill.data.status).not.toMatch(/^running/)

    const t1 = Date.now()
    await startServer() // resumes CREATING/COMING_UP projects on start
    const rerun = await api('/projects', { method: 'POST', body: JSON.stringify({ ref }) })
    expect(rerun.status).toBe(202)
    let project
    for (;;) {
      project = (await api(`/projects/${ref}`)).body
      if (project.status === 'ACTIVE_HEALTHY' || project.status === 'FAILED') break
      if (seconds(t1) > HEALTH_TIMEOUT_S + 60) throw new Error('timed out')
      await sleep(2000)
    }
    const healthyS = seconds(t1)
    log('re-run after kill finished', {
      ref,
      status: project.status,
      seconds: healthyS,
      error: project.last_error,
    })
    expect(project.status).toBe('ACTIVE_HEALTHY')
    expect(project.coolify_service_uuid).toBe(uuid)
    expect(await servicesNamed(ref)).toEqual([uuid])

    await checkStack(ref, uuid)
    const cleanupS = await deleteAndVerify(ref, uuid, 'http')
    killServer('SIGTERM')
    results.kill_and_rerun = {
      registry_status_at_kill: atKill!.status,
      coolify_status_at_kill: coolifyAtKill.data.status,
      seconds_rerun_to_healthy: healthyS,
      coolify_services_with_ref: 1,
      seconds_until_docker_clean: cleanupS,
    }
  }, 1_200_000)

  it('in-process: Coolify creates the service but the uuid is never saved; a re-run adopts it', async () => {
    const real = createCoolifyClient(coolifyConfig)
    const crashing: Coolify = {
      ...real,
      async createService(name, description, compose) {
        await real.createService(name, description, compose)
        throw new Error('simulated crash after Coolify created the service')
      },
    }
    const template = loadTemplate(
      resolve(import.meta.dirname, '../../../deploy/platform/project-compose.yaml')
    )
    const make = (coolify: Coolify) =>
      new Provisioner({
        registry,
        coolify,
        renderCompose: (ref) => renderTemplate(template, templateValues(ref, DOMAIN, STORAGE)),
        serviceEnvs: (s) => serviceEnvs(s, STORAGE),
        healthTimeoutMs: HEALTH_TIMEOUT_S * 1000,
        pollIntervalMs: 5000,
        log: (event, fields) => log(event, fields),
      })

    const { project, done } = await make(crashing).create('live lost uuid')
    await done
    const failed = (await registry.get(project.ref))!
    expect(failed.status).toBe('FAILED')
    expect(failed.coolify_service_uuid).toBeNull()
    const orphan = await servicesNamed(project.ref)
    expect(orphan).toHaveLength(1)

    const t1 = Date.now()
    const provisioner = make(real)
    await provisioner.provision(project.ref)
    const healthyS = seconds(t1)
    const p = (await registry.get(project.ref))!
    log('re-run after lost uuid finished', {
      ref: p.ref,
      status: p.status,
      seconds: healthyS,
      error: p.last_error,
    })
    expect(p.status).toBe('ACTIVE_HEALTHY')
    expect(p.coolify_service_uuid).toBe(orphan[0])
    expect(await servicesNamed(project.ref)).toEqual(orphan)

    const auth = await curlOnB(`http://supabase-auth-${orphan[0]}:9999/health`)
    expect(auth).toBe('200')
    const cleanupS = await deleteAndVerify(p.ref, orphan[0], provisioner)
    results.lost_uuid_rerun = {
      seconds_rerun_to_healthy: healthyS,
      coolify_services_with_ref: 1,
      seconds_until_docker_clean: cleanupS,
    }
  }, 1_200_000)
})
