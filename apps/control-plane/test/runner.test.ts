import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Provisioner } from '../src/provisioner.ts'
import { createRunnerClient } from '../src/runner-client.ts'
import { Pitr } from '../src/runner/pitr.ts'
import { createRunnerServer } from '../src/runner/server.ts'
import { Stacks, stackStatus, type Docker } from '../src/runner/stacks.ts'
import { loadTemplate, renderTemplate, serviceEnvs, templateValues } from '../src/template.ts'
import { fakeShared, MemoryRegistry } from './fakes.ts'

const template = loadTemplate(resolve(import.meta.dirname, '../../../deploy/platform/project-compose.yaml'))
const render = (ref: string) =>
  renderTemplate(
    template,
    templateValues(
      ref,
      'supa.example.com',
      { s3Endpoint: 'http://minio:9000', s3Region: 'us-east-1', imgproxyUrl: 'http://imgproxy:8080' },
      '/data/projects'
    )
  )
const REF = 'qwertyuiopasdfghjklz'
const ENVS = {
  PROJECT_DB_PASSWORD: 'pw1',
  PROJECT_JWT_SECRET: 'jwt1',
  PROJECT_ANON_KEY: 'eyJ.anon.key',
  PROJECT_SERVICE_KEY: 'eyJ.service.key',
  S3_ACCESS_KEY: 'ak',
  S3_SECRET_KEY: 'sk',
}

class FakeDocker implements Docker {
  calls: string[] = []
  up = new Set<string>()
  existingProjects = new Set<string>()
  attached: [string, string, string][] = []
  async compose(id: string, dir: string, args: string[]) {
    this.calls.push(`compose ${id} ${args.join(' ')}`)
    expect(dir.endsWith(id)).toBe(true)
    if (args[0] === 'up') this.up.add(id)
    if (args[0] === 'down') this.up.delete(id)
    if (args[0] === 'ps') {
      if (!this.up.has(id)) return ''
      return ['supabase-db', 'supabase-rest', 'supabase-auth', 'supabase-storage']
        .map((s) => JSON.stringify({ Service: s, State: 'running', Health: s === 'supabase-rest' ? '' : 'healthy' }))
        .join('\n')
    }
    return ''
  }
  async ensureNetwork(name: string) {
    this.calls.push(`network ensure ${name}`)
  }
  async removeNetwork(name: string) {
    this.calls.push(`network rm ${name}`)
  }
  async attach(container: string, network: string, alias: string) {
    this.attached.push([container, network, alias])
  }
  async projectHasContainers(id: string) {
    return this.existingProjects.has(id)
  }
  execs: { container: string; user: string; args: string[]; input?: string }[] = []
  /** What `docker exec` prints, by container and arguments. */
  answer: (container: string, args: string[]) => string = () => ''
  runs: string[][] = []
  removed: string[] = []
  scratchRunning = true
  async exec(container: string, user: string, args: string[], input?: string) {
    this.execs.push({ container, user, args, input })
    return this.answer(container, args)
  }
  signals: string[] = []
  async signal(container: string, signal: string) {
    this.signals.push(`${signal} ${container}`)
  }
  async imageOf() {
    return 'supabase/postgres:15.8.1.085'
  }
  async run(args: string[]) {
    this.runs.push(args)
  }
  async remove(container: string, volumes: string[]) {
    this.removed.push(container, ...volumes)
  }
  async running() {
    return this.scratchRunning
  }
  async logs() {
    return 'FATAL:  recovery ended before configured recovery target was reached\n'
  }
}

let dir: string
let docker: FakeDocker
let stacks: Stacks

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runner-'))
  docker = new FakeDocker()
  stacks = new Stacks({ dir, sharedNetwork: 'shared-net', render, docker })
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('stackStatus', () => {
  const line = (State: string, Health = '') => JSON.stringify({ State, Health })
  it('reads compose ps in the words the provisioner waits for', () => {
    expect(stackStatus('')).toBe('exited')
    expect(stackStatus([line('running', 'healthy'), line('running')].join('\n'))).toBe('running:healthy')
    expect(stackStatus([line('running', 'starting'), line('running')].join('\n'))).toBe('starting:unhealthy')
    expect(stackStatus([line('running', 'healthy'), line('exited')].join('\n'))).toBe('running:unhealthy')
    expect(stackStatus(JSON.stringify([{ State: 'running', Health: 'healthy' }]))).toBe('running:healthy')
  })
})

describe('Stacks', () => {
  it('creates a stack once per ref and finds it again', async () => {
    const id = await stacks.create(REF, 'Demo')
    expect(id).toMatch(/^[a-z0-9]{24}$/)
    expect(await stacks.create(REF, 'Again')).toBe(id)
    expect(await stacks.find(REF)).toBe(id)
    expect(await stacks.find('zzzzzzzzzzzzzzzzzzzz')).toBeNull()
  })

  it('refuses to start without every secret: compose would fill empty passwords', async () => {
    const id = await stacks.create(REF, 'Demo')
    await stacks.setEnvs(id, { PROJECT_DB_PASSWORD: 'pw1' })
    await expect(stacks.start(id)).rejects.toThrow(/lacks PROJECT_JWT_SECRET/)
    expect(docker.calls.some((c) => c.includes(' up '))).toBe(false)
  })

  it('writes .env readable by root only, the compose file and its init files, then starts and attaches', async () => {
    const id = await stacks.create(REF, 'Demo')
    await stacks.setEnvs(id, ENVS)
    const env = join(dir, id, '.env')
    expect((await stat(env)).mode & 0o777).toBe(0o600)
    expect(await readFile(env, 'utf8')).toContain('PROJECT_DB_PASSWORD=pw1\n')
    await stacks.start(id)
    expect(docker.calls).toEqual([
      `network ensure ${id}`,
      `compose ${id} up --no-start --remove-orphans`,
      `compose ${id} up -d --remove-orphans`,
    ])
    expect(await readFile(join(dir, id, 'compose.yaml'), 'utf8')).toContain(`container_name: supabase-db-${id}`)
    expect(await readFile(join(dir, id, 'volumes/db/roles.sql'), 'utf8')).toContain('ALTER USER authenticator')
    expect(docker.attached).toEqual(
      ['supabase-db', 'supabase-rest', 'supabase-auth', 'supabase-storage'].map((s) => [`${s}-${id}`, 'shared-net', `${s}-${id}`])
    )
    expect((await stacks.get(id))?.status).toBe('running:healthy')
  })

  it('takes over a Coolify stack in place only when its containers exist', async () => {
    const coolifyId = 'madebycoolify0000000001x'
    await expect(stacks.create(REF, REF, coolifyId)).rejects.toThrow(/No containers of compose project/)
    docker.existingProjects.add(coolifyId)
    expect(await stacks.create(REF, REF, coolifyId)).toBe(coolifyId)
  })

  it('update writes the template only; restart applies it and restarts; delete removes everything', async () => {
    const id = await stacks.create(REF, 'Demo')
    await stacks.setEnvs(id, ENVS)
    await stacks.update(id)
    expect(docker.calls).toEqual([])
    await stacks.restart(id)
    expect(docker.calls).toEqual([
      `network ensure ${id}`,
      `compose ${id} up --no-start --remove-orphans`,
      `compose ${id} up -d --remove-orphans`,
      `compose ${id} restart`,
    ])
    await stacks.delete(id)
    expect(docker.calls.slice(-2)).toEqual([`compose ${id} down --volumes --remove-orphans`, `network rm ${id}`])
    expect(await stacks.find(REF)).toBeNull()
  })
})

describe('runner API and the control plane over it', () => {
  const token = 'x'.repeat(40)
  let url: string
  let close: () => void

  beforeEach(async () => {
    const pitr = new Pitr({ stacks, docker, sharedNetwork: 'shared-net', sleep: async () => {} })
    const server = createRunnerServer({ stacks, pitr, token })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    close = () => server.close()
  })
  afterEach(() => close())

  it('answers /health without a token and nothing else', async () => {
    expect((await fetch(`${url}/health`)).status).toBe(200)
    expect((await fetch(`${url}/stacks?ref=${REF}`)).status).toBe(401)
    expect((await fetch(`${url}/stacks?ref=${REF}`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
  })

  it('refuses bad refs, unknown variables and malformed ids', async () => {
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const bad = await fetch(`${url}/stacks`, { method: 'POST', headers: auth, body: JSON.stringify({ ref: '../etc', name: 'x' }) })
    expect(bad.status).toBe(400)
    const { id } = await (
      await fetch(`${url}/stacks`, { method: 'POST', headers: auth, body: JSON.stringify({ ref: REF, name: 'x' }) })
    ).json()
    const envs = await fetch(`${url}/stacks/${id}/envs`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ envs: { POSTGRES_HOST: 'evil' } }),
    })
    expect(envs.status).toBe(400)
    expect((await fetch(`${url}/stacks/NOT_AN_ID/start`, { method: 'POST', headers: auth })).status).toBe(404)
  })

  it('refuses a short token', () => {
    const pitr = new Pitr({ stacks, docker, sharedNetwork: 'shared-net' })
    expect(() => createRunnerServer({ stacks, pitr, token: 'short' })).toThrow(/at least 32/)
  })

  it('takes a project from create to ACTIVE_HEALTHY, then deletes it', async () => {
    const registry = new MemoryRegistry()
    const provisioner = new Provisioner({
      registry,
      coolify: createRunnerClient({ url, token }),
      ...fakeShared(registry),
      renderCompose: () => 'never sent to the runner',
      serviceEnvs,
      healthTimeoutMs: 60_000,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    const { project, done } = await provisioner.create('Demo')
    await done
    const p = (await registry.get(project.ref))!
    expect(p.status).toBe('ACTIVE_HEALTHY')
    const id = p.coolify_service_uuid!
    expect(id).toMatch(/^[a-z0-9]{24}$/)
    expect(await readFile(join(dir, id, 'compose.yaml'), 'utf8')).not.toContain('never sent to the runner')
    const env = await readFile(join(dir, id, '.env'), 'utf8')
    expect(env.split('\n').filter(Boolean).map((l) => l.split('=')[0]).sort()).toEqual(Object.keys(ENVS).sort())

    await provisioner.delete(project.ref)
    expect(await registry.get(project.ref)).toBeNull()
    expect(docker.calls).toContain(`compose ${id} down --volumes --remove-orphans`)
  })
})

describe('point-in-time recovery of a stack database', () => {
  const SETTINGS = {
    prefix: 's3://backups/pitr/qwertyuiopasdfghjklz',
    endpoint: 'https://s3.example.com',
    region: 'auto',
    access_key_id: 'AKIDEXAMPLE',
    secret_access_key: 'secretEXAMPLE+/=',
    libsodium_key: 'ab'.repeat(32),
  }
  const LIST = JSON.stringify([
    { backup_name: 'base_000000010000000000000009', start_time: '2026-11-06T02:30:01Z', finish_time: '2026-11-06T02:30:09Z', compressed_size: 10 },
    { backup_name: 'base_000000010000000000000002', start_time: '2026-11-05T02:30:01Z', finish_time: '2026-11-05T02:30:08Z', compressed_size: 9 },
  ])
  let pitr: Pitr
  let id: string

  beforeEach(async () => {
    pitr = new Pitr({ stacks, docker, sharedNetwork: 'shared-net', sleep: async () => {}, scratchTimeoutMs: 60_000 })
    id = await stacks.create(REF, 'Demo')
  })

  it("writes wal-g's files into the config volume as postgres, then reloads Postgres", async () => {
    await pitr.configure(id, SETTINGS)
    const [json, conf] = docker.execs
    expect(json).toMatchObject({ container: `supabase-db-${id}`, user: 'postgres' })
    expect(json.args.join(' ')).toContain('cat > /etc/postgresql-custom/wal-g.json.tmp && chmod 600')
    expect(JSON.parse(json.input!)).toMatchObject({
      WALG_S3_PREFIX: SETTINGS.prefix,
      AWS_ENDPOINT: SETTINGS.endpoint,
      AWS_S3_FORCE_PATH_STYLE: 'true',
      WALG_LIBSODIUM_KEY: SETTINGS.libsodium_key,
      WALG_LIBSODIUM_KEY_TRANSFORM: 'hex',
      PGHOST: '127.0.0.1',
    })
    expect(conf.args.join(' ')).toContain('/etc/postgresql-custom/wal-g.conf')
    expect(conf.input).toContain('archive_mode = on')
    expect(conf.input).toContain(`archive_command = '/usr/local/bin/wal-g wal-push "%p" --config /etc/postgresql-custom/wal-g.json'`)
    expect(conf.input).toContain('archive_timeout = 60')
    expect(docker.signals).toEqual([`HUP supabase-db-${id}`])
  })

  it('turns PITR off without leaving Postgres to keep every WAL file, and drops the keys', async () => {
    await pitr.disable(id)
    const [conf, rm] = docker.execs
    expect(conf.input).toContain('archive_mode = off')
    expect(conf.input).toContain("archive_command = '/bin/true'")
    expect(rm.args).toEqual(['rm', '-f', '/etc/postgresql-custom/wal-g.json'])
    expect(docker.signals).toEqual([`HUP supabase-db-${id}`])
  })

  it('refuses settings that are not what wal-g expects, and unknown stacks', async () => {
    for (const bad of [
      { ...SETTINGS, prefix: 's3://backups/../other' },
      { ...SETTINGS, endpoint: 'https://s3.example.com/x y' },
      { ...SETTINGS, libsodium_key: 'short' },
      { ...SETTINGS, secret_access_key: "a'b" },
      { ...SETTINGS, region: undefined },
    ])
      await expect(pitr.configure(id, bad)).rejects.toThrow(/wal-g setting/)
    await expect(pitr.configure('a'.repeat(24), SETTINGS)).rejects.toThrow(/No stack/)
    expect(docker.execs).toEqual([])
  })

  it('pushes a base backup, keeps the newest ones and lists them oldest first', async () => {
    docker.answer = (_c, args) => (args.includes('backup-list') ? LIST : '')
    const backups = await pitr.backup(id, 7)
    expect(docker.execs.map((e) => e.args.slice(1, 5).join(' '))).toEqual([
      'backup-push /var/lib/postgresql/data --config /etc/postgresql-custom/wal-g.json',
      'delete retain FULL 7',
      'backup-list --json --detail --config',
    ])
    expect(backups.map((b) => b.name)).toEqual(['base_000000010000000000000002', 'base_000000010000000000000009'])
    await expect(pitr.backup(id, 0)).rejects.toThrow(/keep_full/)
  })

  it('reads "No backups found" as an empty list', async () => {
    expect(await pitr.backups(id)).toEqual([])
  })

  it('starts a read-only copy at a moment and waits until it has paused there', async () => {
    let polls = 0
    docker.answer = (container) => (container === `pitr-${id}` ? (++polls < 3 ? 'truereplaying' : 'truepaused') : '')
    const host = await pitr.startScratch(id, 'base_000000010000000000000009', '2026-11-06T10:15:00.000Z')
    expect(host).toBe(`pitr-${id}`)
    expect(docker.removed.slice(0, 2)).toEqual([`pitr-${id}`, `pitr-${id}-data`])
    const args = docker.runs[0].join(' ')
    expect(args).toContain('--network shared-net')
    expect(args).toContain(`-v ${id}_supabase-db-config:/etc/postgresql-custom:ro`)
    expect(args).toContain(`-v pitr-${id}-data:/var/lib/postgresql/data`)
    expect(args).toContain('-e PITR_TARGET=2026-11-06T10:15:00.000Z')
    expect(args).toContain('supabase/postgres:15.8.1.085 -c')
    const script = docker.runs[0].at(-1)!
    expect(script).toContain('-c archive_mode=off')
    expect(script).toContain('-c recovery_target_action=pause')
    expect(script).toContain('-c hot_standby=on')
    expect(polls).toBe(3)
  })

  it('reports a copy that stopped (the moment is past the archive) and removes it', async () => {
    docker.scratchRunning = false
    await expect(pitr.startScratch(id, 'base_000000010000000000000009', '2026-11-06T10:15:00Z')).rejects.toThrow(
      /stopped: FATAL: +recovery ended before configured recovery target/
    )
    expect(docker.removed.filter((r) => r === `pitr-${id}`)).toHaveLength(2)
  })

  it('refuses a malformed backup name or moment', async () => {
    await expect(pitr.startScratch(id, 'base_x; rm -rf /', '2026-11-06T10:15:00Z')).rejects.toThrow(/backup name/)
    await expect(pitr.startScratch(id, 'base_000000010000000000000009', '2026-11-06 10:15')).rejects.toThrow(/target time/)
    expect(docker.runs).toEqual([])
  })

  it('serves all of it over the API, behind the token', async () => {
    const token = 'y'.repeat(40)
    const server = createRunnerServer({ stacks, pitr, token })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/stacks/${id}`
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    try {
      expect((await fetch(`${url}/wal-g/backups`)).status).toBe(401)
      const put = await fetch(`${url}/wal-g`, { method: 'PUT', headers: auth, body: JSON.stringify({ settings: SETTINGS }) })
      expect(put.status).toBe(204)
      const bad = await fetch(`${url}/wal-g`, { method: 'PUT', headers: auth, body: JSON.stringify({ settings: {} }) })
      expect(bad.status).toBe(400)
      docker.answer = (container, args) =>
        container === `pitr-${id}` ? 'truepaused' : args.includes('backup-list') ? LIST : ''
      const pushed = await fetch(`${url}/wal-g/backup`, { method: 'POST', headers: auth, body: JSON.stringify({ keep_full: 7 }) })
      expect((await pushed.json()).backups).toHaveLength(2)
      expect((await (await fetch(`${url}/wal-g/backups`, { headers: auth })).json()).backups).toHaveLength(2)
      const scratch = await fetch(`${url}/pitr-scratch`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ backup: 'base_000000010000000000000009', target_time: '2026-11-06T10:15:00Z' }),
      })
      expect(await scratch.json()).toEqual({ host: `pitr-${id}` })
      expect((await fetch(`${url}/pitr-scratch`, { method: 'DELETE', headers: auth })).status).toBe(204)
      expect((await fetch(`${url}/wal-g`, { method: 'DELETE', headers: auth })).status).toBe(204)
      expect((await fetch(`${url}/wal-g/anything`, { method: 'POST', headers: auth })).status).toBe(404)
    } finally {
      server.close()
    }
  })
})
