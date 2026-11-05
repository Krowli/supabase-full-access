import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Provisioner } from '../src/provisioner.ts'
import { createRunnerClient } from '../src/runner-client.ts'
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
    expect(docker.calls).toEqual([`network ensure ${id}`, `compose ${id} up -d --remove-orphans`])
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
    expect(docker.calls).toEqual([`network ensure ${id}`, `compose ${id} up -d --remove-orphans`, `compose ${id} restart`])
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
    const server = createRunnerServer({ stacks, token })
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
    expect(() => createRunnerServer({ stacks, token: 'short' })).toThrow(/at least 32/)
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
