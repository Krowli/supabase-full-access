import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { Provisioner } from '../src/provisioner.ts'
import { createRunnerClient } from '../src/runner-client.ts'
import { Pitr } from '../src/runner/pitr.ts'
import { createRunnerServer } from '../src/runner/server.ts'
import { Stacks, stackStatus, type Docker } from '../src/runner/stacks.ts'
import { loadTemplate, renderTemplate, serviceEnvs, templateValues } from '../src/template.ts'
import { fakeShared, MemoryRegistry } from './fakes.ts'

const template = loadTemplate(
  resolve(import.meta.dirname, '../../../deploy/platform/project-compose.yaml')
)
const render = (ref: string) =>
  renderTemplate(
    template,
    templateValues(
      ref,
      'supa.example.com',
      {
        s3Endpoint: 'http://minio:9000',
        s3Region: 'us-east-1',
        imgproxyUrl: 'http://imgproxy:8080',
      },
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
    // Like docker compose: no compose file, no command.
    if (!existsSync(join(dir, 'compose.yaml')))
      throw new Error(`compose file ${dir}/compose.yaml is invalid: no such file`)
    if (args[0] === 'up') this.up.add(id)
    if (args[0] === 'down') this.up.delete(id)
    if (args[0] === 'ps') {
      if (!this.up.has(id)) return ''
      return ['supabase-db', 'supabase-rest', 'supabase-auth', 'supabase-storage']
        .map((s) =>
          JSON.stringify({
            Service: s,
            State: 'running',
            Health: s === 'supabase-rest' ? '' : 'healthy',
          })
        )
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
    return 'INFO: 2026/11/06 12:19:32 Finished extraction of backup_label.tar.zst\nBackup extraction complete.\nFATAL:  recovery ended before configured recovery target was reached\n'
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
    expect(stackStatus([line('running', 'healthy'), line('running')].join('\n'))).toBe(
      'running:healthy'
    )
    expect(stackStatus([line('running', 'starting'), line('running')].join('\n'))).toBe(
      'starting:unhealthy'
    )
    expect(stackStatus([line('running', 'healthy'), line('exited')].join('\n'))).toBe(
      'running:unhealthy'
    )
    expect(stackStatus(JSON.stringify([{ State: 'running', Health: 'healthy' }]))).toBe(
      'running:healthy'
    )
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
    expect(await readFile(join(dir, id, 'compose.yaml'), 'utf8')).toContain(
      `container_name: supabase-db-${id}`
    )
    expect(await readFile(join(dir, id, 'volumes/db/roles.sql'), 'utf8')).toContain(
      'ALTER USER authenticator'
    )
    expect(docker.attached).toEqual(
      ['supabase-db', 'supabase-rest', 'supabase-auth', 'supabase-storage'].map((s) => [
        `${s}-${id}`,
        'shared-net',
        `${s}-${id}`,
      ])
    )
    expect((await stacks.get(id))?.status).toBe('running:healthy')
  })

  it('takes over a Coolify stack in place only when its containers exist', async () => {
    const coolifyId = 'madebycoolify0000000001x'
    await expect(stacks.create(REF, REF, coolifyId)).rejects.toThrow(
      /No containers of compose project/
    )
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
    expect(docker.calls.slice(-2)).toEqual([
      `compose ${id} down --volumes --remove-orphans`,
      `network rm ${id}`,
    ])
    expect(await stacks.find(REF)).toBeNull()
  })
})

const PG17 = 'registry.example/postgres:17.6.1.136-walg3.0.5'
const MAIN_DIR = resolve(import.meta.dirname, '../../../deploy/platform/functions-main')
const withOptions = () =>
  new Stacks({
    dir,
    sharedNetwork: 'shared-net',
    render,
    docker,
    postgres17Image: PG17,
    functionsMainDir: MAIN_DIR,
  })
const composeOf = async (id: string) => parse(await readFile(join(dir, id, 'compose.yaml'), 'utf8'))

describe('Postgres major per stack', () => {
  it('runs a stack made on 17 on the 17 image, and one made before (no field) on the template 15', async () => {
    const s = withOptions()
    const old = await s.create(REF, 'Old')
    const pg17 = await s.create('asdfghjklzxcvbnmqwer', 'New', undefined, '17')
    for (const id of [old, pg17]) {
      await s.setEnvs(id, ENVS)
      await s.start(id)
    }
    expect(JSON.parse(await readFile(join(dir, pg17, 'meta.json'), 'utf8')).postgres).toBe('17')
    expect(JSON.parse(await readFile(join(dir, old, 'meta.json'), 'utf8')).postgres).toBeUndefined()
    expect((await composeOf(pg17)).services['supabase-db'].image).toBe(PG17)
    expect((await composeOf(old)).services['supabase-db'].image).toBe('supabase/postgres:15.8.1.085')
    expect((await s.get(pg17))?.postgres).toBe('17')
  })

  it('refuses 17 without an image, unknown majors, and 17 for a stack taken over from Coolify', async () => {
    await expect(stacks.create(REF, 'x', undefined, '17')).rejects.toThrow(/no Postgres 17 image/)
    await expect(withOptions().create(REF, 'x', undefined, '16')).rejects.toThrow(/not one of 15, 17/)
    docker.existingProjects.add('madebycoolify0000000001x')
    await expect(withOptions().create(REF, 'x', 'madebycoolify0000000001x', '17')).rejects.toThrow(
      /runs Postgres 15/
    )
  })

  it('never starts a 17 stack on the 15 image when the runner lost its 17 image', async () => {
    const id = await withOptions().create(REF, 'New', undefined, '17')
    await stacks.setEnvs(id, ENVS)
    await expect(stacks.start(id)).rejects.toThrow(/runs Postgres 17 and this runner has no image/)
    expect(docker.calls.some((c) => c.includes(' up '))).toBe(false)
  })
})

describe('Edge Functions of a stack', () => {
  const bundle = {
    files: {
      'admin-users/index.ts': "Deno.serve(() => new Response('users'))",
      'admin-revenue/index.ts': "import { x } from '../_shared/db.ts'",
      'admin-revenue/deno.json': '{}',
      '_shared/db.ts': 'export const x = 1',
    },
    verify_jwt: { 'admin-users': false },
  }

  it('leaves the functions container out until functions are deployed', async () => {
    const s = withOptions()
    const id = await s.create(REF, 'Demo')
    await s.setEnvs(id, ENVS)
    await s.start(id)
    expect(Object.keys((await composeOf(id)).services)).not.toContain('supabase-functions')
    expect(await s.functions(id)).toEqual({ enabled: false, functions: [], verify_jwt: {}, secrets: [] })
  })

  it('writes the functions whole, with verify_jwt and the router, and (re)starts only their container', async () => {
    const s = withOptions()
    const id = await s.create(REF, 'Demo')
    await s.setEnvs(id, ENVS)
    await s.start(id)
    docker.calls = []
    docker.attached = []
    expect(await s.deployFunctions(id, bundle)).toEqual(['admin-revenue', 'admin-users'])
    expect(docker.calls).toEqual([
      `network ensure ${id}`,
      `compose ${id} up --no-start --no-deps supabase-functions`,
      `compose ${id} up -d --no-deps supabase-functions`,
      `compose ${id} restart supabase-functions`,
    ])
    expect(docker.attached).toEqual([
      [`supabase-functions-${id}`, 'shared-net', `supabase-functions-${id}`],
    ])
    const svc = (await composeOf(id)).services['supabase-functions']
    expect(svc.container_name).toBe(`supabase-functions-${id}`)
    expect(svc['x-platform-only-with']).toBeUndefined()
    expect(svc.environment).toContain('SUPABASE_URL=https://' + REF + '.supa.example.com')
    expect(await readFile(join(dir, id, 'functions/_shared/db.ts'), 'utf8')).toBe('export const x = 1')
    expect(JSON.parse(await readFile(join(dir, id, 'functions/.platform.json'), 'utf8'))).toEqual({
      verify_jwt: { 'admin-users': false },
    })
    expect(await readFile(join(dir, id, 'functions-main/index.ts'), 'utf8')).toContain('verifyJwtFor')

    // A second deploy replaces the folder: a function left out is gone.
    await s.deployFunctions(id, { files: { 'admin-users/index.ts': 'v2' } })
    expect(existsSync(join(dir, id, 'functions/admin-revenue'))).toBe(false)
    expect(await s.functions(id)).toMatchObject({ enabled: true, functions: ['admin-users'], verify_jwt: {} })
    // A restart of the whole stack keeps the functions container.
    await s.restart(id)
    expect(Object.keys((await composeOf(id)).services)).toContain('supabase-functions')
  })

  it('keeps secrets in a file only root reads, gives back their names, and refuses reserved ones', async () => {
    const s = withOptions()
    const id = await s.create(REF, 'Demo')
    await s.setEnvs(id, ENVS)
    expect(await s.setFunctionSecrets(id, { STRIPE_SECRET_KEY: 'sk_live_x', GMAIL_CLIENT_ID: 'a=b' })).toEqual([
      'GMAIL_CLIENT_ID',
      'STRIPE_SECRET_KEY',
    ])
    const file = join(dir, id, 'functions.env')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, 'utf8')).toBe('STRIPE_SECRET_KEY=sk_live_x\nGMAIL_CLIENT_ID=a=b\n')
    expect(docker.calls).toEqual([]) // no functions yet: nothing to restart
    expect((await s.functions(id)).secrets).toEqual(['GMAIL_CLIENT_ID', 'STRIPE_SECRET_KEY'])
    for (const bad of [{ SUPABASE_URL: 'x' }, { JWT_SECRET: 'x' }, { 'A-B': 'x' }, { A: 'two\nlines' }, { A: 1 }])
      await expect(s.setFunctionSecrets(id, bad)).rejects.toThrow()
  })

  it('refuses paths out of the folder, bundles without a function, and verify_jwt for others', async () => {
    const s = withOptions()
    const id = await s.create(REF, 'Demo')
    for (const files of [
      { '../x/index.ts': 'x' },
      { 'a/../../x.ts': 'x' },
      { '/etc/passwd': 'x' },
      { 'a/.env': 'x' },
      { '_shared/db.ts': 'x' },
      { 'index.ts': 'x' },
      {},
    ])
      await expect(s.deployFunctions(id, { files })).rejects.toThrow()
    await expect(
      s.deployFunctions(id, { files: { 'a/index.ts': 'x' }, verify_jwt: { b: false } })
    ).rejects.toThrow(/not a function here/)
    expect(existsSync(join(dir, id, 'functions'))).toBe(false)
  })

  it('turns functions off: container, files, secrets and the compose service go', async () => {
    const s = withOptions()
    const id = await s.create(REF, 'Demo')
    await s.setEnvs(id, ENVS)
    await s.start(id)
    await s.deployFunctions(id, bundle)
    await s.setFunctionSecrets(id, { A: 'b' })
    await s.removeFunctions(id)
    expect(docker.removed).toContain(`supabase-functions-${id}`)
    for (const name of ['functions', 'functions-main', 'functions.env'])
      expect(existsSync(join(dir, id, name))).toBe(false)
    expect(Object.keys((await composeOf(id)).services)).not.toContain('supabase-functions')
    expect(await s.functions(id)).toEqual({ enabled: false, functions: [], verify_jwt: {}, secrets: [] })
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
    expect(
      (await fetch(`${url}/stacks?ref=${REF}`, { headers: { Authorization: 'Bearer wrong' } }))
        .status
    ).toBe(401)
  })

  it('refuses bad refs, unknown variables and malformed ids', async () => {
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const bad = await fetch(`${url}/stacks`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ref: '../etc', name: 'x' }),
    })
    expect(bad.status).toBe(400)
    const { id } = await (
      await fetch(`${url}/stacks`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ref: REF, name: 'x' }),
      })
    ).json()
    const envs = await fetch(`${url}/stacks/${id}/envs`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ envs: { POSTGRES_HOST: 'evil' } }),
    })
    expect(envs.status).toBe(400)
    expect(
      (await fetch(`${url}/stacks/NOT_AN_ID/start`, { method: 'POST', headers: auth })).status
    ).toBe(404)
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
    expect(await readFile(join(dir, id, 'compose.yaml'), 'utf8')).not.toContain(
      'never sent to the runner'
    )
    const env = await readFile(join(dir, id, '.env'), 'utf8')
    expect(
      env
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('=')[0])
        .sort()
    ).toEqual(Object.keys(ENVS).sort())

    await provisioner.delete(project.ref)
    expect(await registry.get(project.ref)).toBeNull()
    expect(docker.calls).toContain(`compose ${id} down --volumes --remove-orphans`)
  })
})

describe('a Postgres 17 project with Edge Functions, control plane to runner over HTTP', () => {
  const token = 'y'.repeat(40)
  it('makes it on 17, deploys functions and their secrets, routes them, and turns them off', async () => {
    const s = withOptions()
    const pitr = new Pitr({ stacks: s, docker, sharedNetwork: 'shared-net' })
    const server = createRunnerServer({ stacks: s, pitr, token })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const registry = new MemoryRegistry()
      const shared = fakeShared(registry)
      const provisioner = new Provisioner({
        registry,
        coolify: createRunnerClient({ url, token }),
        ...shared,
        renderCompose: () => '',
        serviceEnvs,
        healthTimeoutMs: 60_000,
        pollIntervalMs: 0,
        sleep: async () => {},
        newProjectPostgres: '17',
      })
      const { project, done } = await provisioner.create('Shop')
      await done
      const p = (await registry.get(project.ref))!
      expect(p).toMatchObject({ status: 'ACTIVE_HEALTHY', postgres_version: '17', functions: false })
      const id = p.coolify_service_uuid!
      expect((await composeOf(id)).services['supabase-db'].image).toBe(PG17)

      // A bad bundle comes back as the runner's 400, with its reason.
      await expect(provisioner.deployFunctions(p.ref, { files: { '../x': 'y' } })).rejects.toThrow(
        /400.*Invalid file path/
      )
      expect(
        await provisioner.deployFunctions(p.ref, {
          files: { 'hello/index.ts': 'Deno.serve(() => new Response("hi"))' },
          verify_jwt: { hello: false },
        })
      ).toEqual(['hello'])
      expect((await registry.get(p.ref))!.functions).toBe(true)
      expect(Object.keys((await composeOf(id)).services)).toContain('supabase-functions')
      expect(await provisioner.setFunctionSecrets(p.ref, { STRIPE_SECRET_KEY: 'sk' })).toEqual([
        'STRIPE_SECRET_KEY',
      ])
      expect(await provisioner.functions(p.ref)).toEqual({
        enabled: true,
        functions: ['hello'],
        verify_jwt: { hello: false },
        secrets: ['STRIPE_SECRET_KEY'],
      })

      await provisioner.removeFunctions(p.ref)
      expect((await registry.get(p.ref))!.functions).toBe(false)
      expect(Object.keys((await composeOf(id)).services)).not.toContain('supabase-functions')
    } finally {
      server.close()
    }
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
    {
      backup_name: 'base_000000010000000000000009',
      start_time: '2026-11-06T02:30:01Z',
      finish_time: '2026-11-06T02:30:09Z',
      compressed_size: 10,
    },
    {
      backup_name: 'base_000000010000000000000002',
      start_time: '2026-11-05T02:30:01Z',
      finish_time: '2026-11-05T02:30:08Z',
      compressed_size: 9,
    },
  ])
  let pitr: Pitr
  let id: string

  beforeEach(async () => {
    pitr = new Pitr({
      stacks,
      docker,
      sharedNetwork: 'shared-net',
      sleep: async () => {},
      scratchTimeoutMs: 60_000,
    })
    id = await stacks.create(REF, 'Demo')
  })

  it("writes wal-g's files into the config volume as postgres, then reloads Postgres", async () => {
    await pitr.configure(id, SETTINGS)
    const [json, conf] = docker.execs
    expect(json).toMatchObject({ container: `supabase-db-${id}`, user: 'postgres' })
    expect(json.args.join(' ')).toContain(
      'cat > /etc/postgresql-custom/wal-g.json.tmp && chmod 600'
    )
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
    expect(conf.input).toContain(
      `archive_command = '/usr/local/bin/wal-g wal-push "%p" --config /etc/postgresql-custom/wal-g.json'`
    )
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
    expect(backups.map((b) => b.name)).toEqual([
      'base_000000010000000000000002',
      'base_000000010000000000000009',
    ])
    await expect(pitr.backup(id, 0)).rejects.toThrow(/keep_full/)
  })

  it('reads "No backups found" as an empty list', async () => {
    expect(await pitr.backups(id)).toEqual([])
  })

  it('starts a read-only copy at a moment and waits until it has paused there', async () => {
    let polls = 0
    docker.answer = (container) =>
      container === `pitr-${id}` ? (++polls < 3 ? 'truereplaying' : 'truepaused') : ''
    const host = await pitr.startScratch(
      id,
      'base_000000010000000000000009',
      '2026-11-06T10:15:00.000Z'
    )
    expect(host).toBe(`pitr-${id}`)
    expect(docker.removed.slice(0, 2)).toEqual([`pitr-${id}`, `pitr-${id}-data`])
    const args = docker.runs[0].join(' ')
    expect(args).toContain('--network shared-net')
    expect(args).toContain(`-v ${id}_supabase-db-config:/etc/postgresql-custom:ro`)
    expect(args).toContain(`-v pitr-${id}-data:/var/lib/postgresql/data`)
    expect(docker.runs[0]).toContain('PITR_TARGET=2026-11-06 10:15:00.000+00')
    expect(args).toContain('supabase/postgres:15.8.1.085 -c')
    const script = docker.runs[0].at(-1)!
    expect(script).toContain('-c archive_mode=off')
    expect(script).toContain('-c recovery_target_action=pause')
    expect(script).toContain('-c hot_standby=on')
    expect(polls).toBe(3)
  })

  it('reports a copy that stopped (the moment is past the archive) and removes it', async () => {
    docker.scratchRunning = false
    await expect(
      pitr.startScratch(id, 'base_000000010000000000000009', '2026-11-06T10:15:00Z')
    ).rejects.toThrow(
      /stopped: Backup extraction complete\. \| FATAL: +recovery ended before configured recovery target was reached$/
    )
    expect(docker.removed.filter((r) => r === `pitr-${id}`)).toHaveLength(2)
  })

  it('refuses a malformed backup name or moment', async () => {
    await expect(pitr.startScratch(id, 'base_x; rm -rf /', '2026-11-06T10:15:00Z')).rejects.toThrow(
      /backup name/
    )
    await expect(
      pitr.startScratch(id, 'base_000000010000000000000009', '2026-11-06 10:15')
    ).rejects.toThrow(/target time/)
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
      const put = await fetch(`${url}/wal-g`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ settings: SETTINGS }),
      })
      expect(put.status).toBe(204)
      const bad = await fetch(`${url}/wal-g`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ settings: {} }),
      })
      expect(bad.status).toBe(400)
      docker.answer = (container, args) =>
        container === `pitr-${id}` ? 'truepaused' : args.includes('backup-list') ? LIST : ''
      const pushed = await fetch(`${url}/wal-g/backup`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ keep_full: 7 }),
      })
      expect((await pushed.json()).backups).toHaveLength(2)
      expect(
        (await (await fetch(`${url}/wal-g/backups`, { headers: auth })).json()).backups
      ).toHaveLength(2)
      const scratch = await fetch(`${url}/pitr-scratch`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          backup: 'base_000000010000000000000009',
          target_time: '2026-11-06T10:15:00Z',
        }),
      })
      expect(await scratch.json()).toEqual({ host: `pitr-${id}` })
      expect((await fetch(`${url}/pitr-scratch`, { method: 'DELETE', headers: auth })).status).toBe(
        204
      )
      expect((await fetch(`${url}/wal-g`, { method: 'DELETE', headers: auth })).status).toBe(204)
      expect((await fetch(`${url}/wal-g/anything`, { method: 'POST', headers: auth })).status).toBe(
        404
      )
    } finally {
      server.close()
    }
  })
})
