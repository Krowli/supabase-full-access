import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Provisioner } from '../src/provisioner.ts'
import { createApp } from '../src/server.ts'
import { fakeShared, FakeCoolify, MemoryRegistry } from './fakes.ts'

const TOKEN = 'test-token'
const registry = new MemoryRegistry()
const coolify = new FakeCoolify()
const provisioner = new Provisioner({
  registry,
  coolify,
  ...fakeShared(registry),
  renderCompose: () => 'c',
  serviceEnvs: () => ({}),
  healthTimeoutMs: 60_000,
  pollIntervalMs: 0,
  sleep: async () => {},
})
const server = createApp({
  registry,
  provisioner,
  apiToken: TOKEN,
  domainSuffix: 'supa.example.com',
  extraHosts: ['studio.supa.example.com'],
})
let base = ''

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const api = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
  fetch(base + path, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
  })

describe('HTTP API', () => {
  it('serves /health without a token and everything else only with the right one', async () => {
    expect((await api('/health', {}, null)).status).toBe(200)
    expect((await api('/projects', {}, null)).status).toBe(401)
    expect((await api('/projects', {}, 'wrong-token')).status).toBe(401)
    expect((await api('/projects')).status).toBe(200)
  })

  it('lists the hostnames of routed projects at /hosts without a token', async () => {
    const { project, done } = await provisioner.create('Hosts')
    await done
    const res = await api('/hosts', {}, null)
    expect(res.status).toBe(200)
    const hosts = (await res.text()).split('\n')
    expect(hosts).toContain(`${project.ref}.supa.example.com`)
    expect(hosts[0]).toBe('studio.supa.example.com')
    await provisioner.delete(project.ref)
    expect(await (await api('/hosts', {}, null)).text()).not.toContain(project.ref)
  })

  it('creates, lists, shows (without secrets), reveals secrets and deletes a project', async () => {
    const created = await api('/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Shop' }),
    })
    expect(created.status).toBe(201)
    const project = await created.json()
    expect(project).toMatchObject({ name: 'Shop', status: 'CREATING' })
    expect(project.ref).toMatch(/^[a-z]{20}$/)
    expect(project.endpoint).toBe(`https://${project.ref}.supa.example.com`)

    await provisioner.provision(project.ref)
    const shown = await (await api(`/projects/${project.ref}`)).json()
    expect(shown.status).toBe('ACTIVE_HEALTHY')
    expect(shown.internal.db_host).toBe(`supabase-db-${shown.coolify_service_uuid}`)
    const secrets = (await registry.getSecrets(project.ref))!
    const shownText = JSON.stringify(shown)
    for (const value of Object.values(secrets)) expect(shownText).not.toContain(value)

    const list = await (await api('/projects')).json()
    expect(list.map((p: { ref: string }) => p.ref)).toContain(project.ref)
    expect(JSON.stringify(list)).not.toContain(secrets.jwt_secret)

    const revealed = await (await api(`/projects/${project.ref}/secrets`)).json()
    expect(revealed).toEqual({ ref: project.ref, ...secrets })

    expect((await api(`/projects/${project.ref}`, { method: 'DELETE' })).status).toBe(200)
    expect((await api(`/projects/${project.ref}`)).status).toBe(404)
    expect((await api(`/projects/${project.ref}/secrets`)).status).toBe(404)
  })

  it('re-runs provisioning for an existing ref', async () => {
    coolify.failOnce.set('setEnvs', 'before')
    const { project, done } = await provisioner.create('Retry')
    await done
    expect((await registry.get(project.ref))!.status).toBe('FAILED')

    const res = await api('/projects', {
      method: 'POST',
      body: JSON.stringify({ ref: project.ref }),
    })
    expect(res.status).toBe(202)
    await provisioner.provision(project.ref)
    expect((await registry.get(project.ref))!.status).toBe('ACTIVE_HEALTHY')
  })

  it('validates input', async () => {
    expect((await api('/projects', { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await api('/projects', { method: 'POST', body: 'nope' })).status).toBe(400)
    expect(
      (await api('/projects', { method: 'POST', body: JSON.stringify({ ref: 'x' }) })).status
    ).toBe(400)
    const unknown = JSON.stringify({ ref: 'zzzzzzzzzzzzzzzzzzzz' })
    expect((await api('/projects', { method: 'POST', body: unknown })).status).toBe(404)
    expect((await api('/projects/zzzzzzzzzzzzzzzzzzzz', { method: 'DELETE' })).status).toBe(404)
    expect((await api('/nope')).status).toBe(404)
  })
})
