import { describe, expect, it } from 'vitest'

import { KongGateway, renderKongConfig, type GatewayProject, type KongConfig } from '../src/kong.ts'
import { generateProjectSecrets } from '../src/secrets.ts'

const opts = { domainSuffix: 'supa.example.com', realtimeUrl: 'http://realtime:4000' }
const project = (ref: string, uuid: string): GatewayProject => {
  const s = generateProjectSecrets(ref)
  return { ref, uuid, anonKey: s.anon_key, serviceKey: s.service_key }
}
const a = project('aaaaaaaaaaaaaaaaaaaa', 'uuida')
const b = project('bbbbbbbbbbbbbbbbbbbb', 'uuidb')

type Route = { hosts: string[]; paths: string[]; preserve_host?: boolean }
const service = (c: KongConfig, name: string) => {
  const s = c.services.find((x) => x.name === name)
  if (!s) throw new Error(`no service ${name}`)
  return {
    ...s,
    route: s.routes[0] as Route,
    plugin: (n: string) => s.plugins.find((p) => p.name === n),
  }
}

describe('renderKongConfig', () => {
  const config = renderKongConfig([b, a], opts)

  it('scopes every route to its project host and upstream containers', () => {
    for (const s of config.services) {
      const ref = s.name.slice(0, 20)
      expect((s.routes[0] as Route).hosts).toEqual([`${ref}.supa.example.com`])
    }
    expect(service(config, `${a.ref}-rest-v1`).url).toBe('http://supabase-rest-uuida:3000/')
    expect(service(config, `${b.ref}-auth-v1`).url).toBe('http://supabase-auth-uuidb:9999/')
    expect(service(config, `${a.ref}-storage-v1`).url).toBe('http://supabase-storage-uuida:5000/')
    expect(service(config, `${a.ref}-auth-v1-open`).route.paths).toEqual(['/auth/v1/verify'])
  })

  it("lets only the project's own keys through its keyed routes", () => {
    for (const name of ['auth-v1', 'rest-v1', 'graphql-v1', 'realtime-v1-ws', 'realtime-v1-rest']) {
      const s = service(config, `${a.ref}-${name}`)
      expect(s.plugin('key-auth'), name).toBeDefined()
      expect(s.plugin('acl')?.config).toMatchObject({ allow: [`${a.ref}-admin`, `${a.ref}-anon`] })
    }
    expect(config.consumers).toEqual(
      expect.arrayContaining([
        {
          username: `${a.ref}-anon`,
          keyauth_credentials: [{ key: a.anonKey }],
          acls: [{ group: `${a.ref}-anon` }],
        },
        {
          username: `${a.ref}-service_role`,
          keyauth_credentials: [{ key: a.serviceKey }],
          acls: [{ group: `${a.ref}-admin` }],
        },
      ])
    )
    expect(config.consumers).toHaveLength(4)
    // Open auth endpoints and storage carry no key-auth, as in the fork's kong.yml.
    expect(service(config, `${a.ref}-auth-v1-open`).plugin('key-auth')).toBeUndefined()
    expect(service(config, `${a.ref}-storage-v1`).plugin('key-auth')).toBeUndefined()
  })

  it('sends Realtime the project host so it picks the right tenant, and blocks its admin API', () => {
    const ws = service(config, `${a.ref}-realtime-v1-ws`)
    expect(ws.url).toBe('http://realtime:4000/socket')
    expect(ws.route.preserve_host).toBe(true)
    expect(
      service(config, `${a.ref}-realtime-v1-rest-tenants`).plugin('request-termination')
    ).toBeDefined()
  })

  it('is deterministic and empty without projects', () => {
    expect(renderKongConfig([a, b], opts)).toEqual(config)
    expect(renderKongConfig([], opts)).toEqual({
      _format_version: '3.0',
      consumers: [],
      services: [],
    })
  })

  it('routes the dashboard host to Studio behind basic auth, apart from every project', () => {
    const dashboard = { url: 'http://studio:3000', username: 'operator1', password: 'pass-word.123' }
    const c = renderKongConfig([a], { ...opts, dashboard })
    const d = service(c, 'dashboard')
    expect(d.url).toBe('http://studio:3000/')
    expect(d.route.hosts).toEqual(['studio.supa.example.com'])
    expect(d.route.paths).toEqual(['/'])
    expect(d.plugin('basic-auth')?.config).toEqual({ hide_credentials: true })
    expect(d.plugin('key-auth')).toBeUndefined()
    expect(d.read_timeout).toBeGreaterThanOrEqual(120_000)
    const consumer = c.consumers.find((x) => x.username === 'dashboard')
    expect(consumer).toEqual({
      username: 'dashboard',
      basicauth_credentials: [{ username: 'operator1', password: 'pass-word.123' }],
    })
    // In no ACL group: its credentials open no project route.
    expect(consumer).not.toHaveProperty('acls')
    // The project routes are unchanged.
    expect(c.services.filter((s) => s.name !== 'dashboard')).toEqual(
      renderKongConfig([a], opts).services
    )
    expect(() =>
      renderKongConfig([], { ...opts, dashboard: { ...dashboard, password: "x'y\nz12345" } })
    ).toThrow(/credentials/)
    expect(() =>
      renderKongConfig([], { ...opts, dashboard: { ...dashboard, url: 'http://studio:3000/x?y' } })
    ).toThrow(/dashboard url/)
  })

  it('refuses values that could inject config', () => {
    expect(() => renderKongConfig([{ ...a, ref: 'x' }], opts)).toThrow(/invalid ref/)
    expect(() => renderKongConfig([{ ...a, uuid: 'a:b' }], opts)).toThrow(/uuid/)
    expect(() => renderKongConfig([{ ...a, anonKey: "x'y" }], opts)).toThrow(/malformed/)
  })
})

/** Kong's admin API in memory: validates like DB-less Kong (all or nothing) and hashes. */
function fakeKong() {
  const state = {
    hash: '00000000000000000000000000000000',
    config: null as KongConfig | null,
    posts: 0,
    reject: false,
  }
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    if ((init?.headers as Record<string, string>)['x-admin-token'] !== 'tok')
      return new Response('', { status: 401 })
    if (path === '/status') return Response.json({ configuration_hash: state.hash })
    if (path === '/config' && init?.method === 'POST') {
      state.posts++
      if (state.reject)
        return Response.json(
          {
            message: 'invalid',
            flattened_errors: [
              {
                entity_type: 'service',
                entity_name: 'x',
                errors: [{ field: 'host', message: 'required' }],
              },
            ],
          },
          { status: 400 }
        )
      state.config = JSON.parse(String(init.body))
      state.hash = String(state.posts).padStart(32, '0')
      return Response.json({}, { status: 201 })
    }
    return new Response('', { status: 404 })
  }
  return { state, fetchImpl }
}

describe('KongGateway', () => {
  it('applies, keeps the last good config when Kong rejects one, and restores it after a Kong restart', async () => {
    const kong = fakeKong()
    const consumers = () => kong.state.config?.consumers
    const original = globalThis.fetch
    globalThis.fetch = kong.fetchImpl as typeof fetch
    try {
      let projects = [a]
      const gw = new KongGateway({
        adminUrl: 'http://kong:8001',
        adminToken: 'tok',
        load: async () => projects,
        render: (p) => renderKongConfig(p, opts),
      })
      await gw.sync()
      expect(consumers()).toHaveLength(2)

      kong.state.reject = true
      projects = [a, b]
      await expect(gw.sync()).rejects.toThrow(
        /Kong rejected the config \(400\): service x: host required/
      )
      expect(consumers()).toHaveLength(2)
      kong.state.reject = false

      // In sync: reconcile does nothing.
      const posts = kong.state.posts
      await gw.reconcile()
      expect(kong.state.posts).toBe(posts)

      // Kong restarted empty: reconcile renders the current registry and applies it.
      kong.state.hash = '00000000000000000000000000000000'
      kong.state.config = null
      await gw.reconcile()
      expect(consumers()).toHaveLength(4)

      // Restarted again while the registry cannot be rendered: the last good config goes back.
      kong.state.hash = '00000000000000000000000000000000'
      projects = [{ ...a, ref: 'bad' }]
      await gw.reconcile()
      expect(consumers()).toHaveLength(4)
    } finally {
      globalThis.fetch = original
    }
  })
})
