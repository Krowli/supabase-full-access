// The shared Kong runs DB-less. The control plane owns its whole declarative config: it renders
// it from the registry and applies it with the admin API's `POST /config`, which validates the
// entire config and swaps it atomically, or answers 400 and keeps serving the previous one.
// Routes follow docker/volumes/api/kong.yml, scoped per project by `hosts: [<ref>.<suffix>]`.

/** A project as Kong routes it. Upstreams are the project containers on the `coolify` network. */
export type GatewayProject = { ref: string; uuid: string; anonKey: string; serviceKey: string }

export type KongRenderOptions = {
  domainSuffix: string
  /** The shared Realtime as Kong reaches it, e.g. http://realtime:4000. */
  realtimeUrl: string
  /** Studio behind basic auth at `studio.<suffix>`, like the fork kong.yml's `dashboard` route. */
  dashboard?: DashboardOptions
}

export type DashboardOptions = {
  /** Studio as Kong reaches it, e.g. http://studio:3000. */
  url: string
  username: string
  password: string
}

/** The dashboard's public host label. Project refs are 20 letters, so it cannot be a ref. */
export const DASHBOARD_LABEL = 'studio'

export const dashboardHost = (domainSuffix: string) => `${DASHBOARD_LABEL}.${domainSuffix}`

type Plugin = { name: string; config?: Record<string, unknown> }
type KongService = {
  name: string
  url: string
  connect_timeout?: number
  read_timeout?: number
  write_timeout?: number
  routes: Record<string, unknown>[]
  plugins: Plugin[]
}
export type KongConfig = {
  _format_version: '3.0'
  consumers: Record<string, unknown>[]
  services: KongService[]
}

// The fork's legacy-key expression (kong-entrypoint.sh): pass the caller's Authorization through,
// else use the apikey. Kong evaluates $(...) per request.
const AUTH_EXPR =
  "$((headers.authorization ~= nil and headers.authorization:sub(1, 10) ~= 'Bearer sb_' and headers.authorization) or headers.apikey)"

const REF = /^[a-z]{20}$/
const UUID = /^[a-z0-9]+$/
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const DASHBOARD_URL = /^http:\/\/[a-z0-9.-]+(:\d+)?\/?$/
const BASIC_AUTH_VALUE = /^[A-Za-z0-9._-]{8,128}$/

/**
 * Studio (all paths) on its own host, behind basic auth. The consumer is in no ACL group, so its
 * credentials open no project route, and no project key opens this one.
 */
function renderDashboard(d: DashboardOptions, domainSuffix: string) {
  if (!DASHBOARD_URL.test(d.url)) throw new Error('Kong: invalid dashboard url')
  if (!BASIC_AUTH_VALUE.test(d.username) || !BASIC_AUTH_VALUE.test(d.password))
    throw new Error('Kong: dashboard credentials must be 8-128 letters, digits, ".", "_" or "-"')
  const consumer = {
    username: 'dashboard',
    basicauth_credentials: [{ username: d.username, password: d.password }],
  }
  const service: KongService = {
    name: 'dashboard',
    url: `${d.url.replace(/\/+$/, '')}/`,
    // Studio's project delete waits for the control plane's DELETE, which runs every step.
    read_timeout: 180_000,
    write_timeout: 180_000,
    routes: [
      { name: 'dashboard', hosts: [dashboardHost(domainSuffix)], paths: ['/'], strip_path: true },
    ],
    plugins: [{ name: 'cors' }, { name: 'basic-auth', config: { hide_credentials: true } }],
  }
  return { consumer, service }
}

/** Renders the full declarative config. Throws on any value that does not look right. */
export function renderKongConfig(projects: GatewayProject[], opts: KongRenderOptions): KongConfig {
  const consumers: KongConfig['consumers'] = []
  const services: KongService[] = []
  const realtime = opts.realtimeUrl.replace(/\/+$/, '')

  for (const p of [...projects].sort((a, b) => a.ref.localeCompare(b.ref))) {
    if (!REF.test(p.ref)) throw new Error(`Kong: invalid ref ${JSON.stringify(p.ref)}`)
    if (!UUID.test(p.uuid)) throw new Error(`Kong: invalid service uuid for ${p.ref}`)
    if (!JWT.test(p.anonKey) || !JWT.test(p.serviceKey))
      throw new Error(`Kong: malformed API keys for ${p.ref}`)

    const host = `${p.ref}.${opts.domainSuffix}`
    const anon = `${p.ref}-anon`
    const admin = `${p.ref}-admin`
    consumers.push(
      { username: anon, keyauth_credentials: [{ key: p.anonKey }], acls: [{ group: anon }] },
      {
        username: `${p.ref}-service_role`,
        keyauth_credentials: [{ key: p.serviceKey }],
        acls: [{ group: admin }],
      }
    )

    const auth = `http://supabase-auth-${p.uuid}:9999`
    const rest = `http://supabase-rest-${p.uuid}:3000`
    const storage = `http://supabase-storage-${p.uuid}:5000`
    const cors: Plugin = { name: 'cors' }
    const keyAuth: Plugin[] = [
      { name: 'key-auth', config: { hide_credentials: false } },
      { name: 'acl', config: { hide_groups_header: true, allow: [admin, anon] } },
    ]
    const authHeader: Plugin = {
      name: 'request-transformer',
      config: {
        add: { headers: [`Authorization: ${AUTH_EXPR}`] },
        replace: { headers: [`Authorization: ${AUTH_EXPR}`] },
      },
    }
    const forbidden: Plugin = {
      name: 'request-termination',
      config: { status_code: 403, message: 'Access is forbidden.' },
    }
    const add = (
      name: string,
      url: string,
      path: string,
      plugins: Plugin[],
      extra: { route?: Record<string, unknown>; service?: Partial<KongService> } = {}
    ) =>
      services.push({
        name: `${p.ref}-${name}`,
        url,
        ...extra.service,
        routes: [
          {
            name: `${p.ref}-${name}`,
            hosts: [host],
            paths: [path],
            strip_path: true,
            ...extra.route,
          },
        ],
        plugins,
      })

    // Auth: the open endpoints (links in emails, OAuth, SAML, JWKS), then the keyed rest.
    for (const [name, path] of [
      ['auth-v1-open', '/verify'],
      ['auth-v1-open-callback', '/callback'],
      ['auth-v1-open-authorize', '/authorize'],
      ['auth-v1-open-jwks', '/.well-known/jwks.json'],
      ['auth-v1-open-sso-acs', '/sso/saml/acs'],
      ['auth-v1-open-sso-metadata', '/sso/saml/metadata'],
    ]) {
      add(name, auth + path, `/auth/v1${path}`, [cors])
    }
    add('auth-v1', `${auth}/`, '/auth/v1/', [cors, ...keyAuth, authHeader])
    add(
      'well-known-oauth',
      `${auth}/.well-known/oauth-authorization-server`,
      '/.well-known/oauth-authorization-server',
      [cors]
    )

    add('rest-v1', `${rest}/`, '/rest/v1/', [cors, ...keyAuth, authHeader])
    add('graphql-v1', `${rest}/rpc/graphql`, '/graphql/v1', [
      cors,
      ...keyAuth,
      {
        name: 'request-transformer',
        config: {
          add: { headers: ['Content-Profile: graphql_public', `Authorization: ${AUTH_EXPR}`] },
          replace: { headers: [`Authorization: ${AUTH_EXPR}`] },
        },
      },
    ])

    // Realtime picks the tenant from the Host header's first label, so the host is preserved.
    const keepHost = { route: { preserve_host: true } }
    add(
      'realtime-v1-ws',
      `${realtime}/socket`,
      '/realtime/v1/',
      [
        cors,
        ...keyAuth,
        {
          name: 'request-transformer',
          config: { add: { headers: ['x-api-key:$(query_params.apikey)'] } },
        },
      ],
      keepHost
    )
    add('realtime-v1-rest-openapi', `${realtime}/api/openapi`, '/realtime/v1/api/openapi', [
      forbidden,
    ])
    add('realtime-v1-rest-tenants', `${realtime}/api/tenants`, '/realtime/v1/api/tenants', [
      forbidden,
    ])
    add(
      'realtime-v1-rest',
      `${realtime}/api`,
      '/realtime/v1/api',
      [cors, ...keyAuth, authHeader],
      keepHost
    )

    // Storage checks the JWT itself and also serves S3 requests that carry no apikey.
    add(
      'storage-v1',
      `${storage}/`,
      '/storage/v1/',
      [
        cors,
        authHeader,
        {
          name: 'post-function',
          config: {
            access: [
              'local auth = kong.request.get_header("authorization")\nif auth == nil or auth == "" or auth:find("^%s*$") then\n  kong.service.request.clear_header("authorization")\nend',
            ],
          },
        },
      ],
      {
        service: { connect_timeout: 60_000, read_timeout: 3_600_000, write_timeout: 3_600_000 },
        route: { request_buffering: false, response_buffering: false },
      }
    )
  }
  if (opts.dashboard) {
    const { consumer, service } = renderDashboard(opts.dashboard, opts.domainSuffix)
    consumers.unshift(consumer)
    services.unshift(service)
  }
  return { _format_version: '3.0', consumers, services }
}

export interface Gateway {
  /** Renders the config from the registry and applies it. Runs are serialised. */
  sync(): Promise<void>
}

export type KongGatewayOptions = {
  adminUrl: string
  adminToken: string
  /** Every project Kong should route, read fresh from the registry on each sync. */
  load: () => Promise<GatewayProject[]>
  render: (projects: GatewayProject[]) => KongConfig
  log?: (event: string, fields: Record<string, unknown>) => void
}

const EMPTY_HASH = '00000000000000000000000000000000'

/**
 * Applies configs through Kong's admin API (which only answers requests with the
 * `x-admin-token` header, see platform-compose.yaml). The last config Kong accepted is kept in
 * memory with Kong's hash of it; reconcile() puts it back when Kong lost it (a restart starts
 * DB-less Kong empty) or drifted.
 */
export class KongGateway implements Gateway {
  private opts: KongGatewayOptions
  private queue: Promise<unknown> = Promise.resolve()
  private lastGood: { config: KongConfig; hash: string } | null = null
  private log: (event: string, fields: Record<string, unknown>) => void

  constructor(opts: KongGatewayOptions) {
    this.opts = opts
    this.log = opts.log ?? (() => {})
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  private async admin(method: string, path: string, body?: unknown) {
    const res = await fetch(this.opts.adminUrl.replace(/\/+$/, '') + path, {
      method,
      headers: {
        'x-admin-token': this.opts.adminToken,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    return {
      status: res.status,
      json: (await res.json().catch(() => null)) as Record<string, unknown> | null,
    }
  }

  async currentHash(): Promise<string> {
    const res = await this.admin('GET', '/status')
    if (res.status !== 200) throw new Error(`Kong GET /status -> ${res.status}`)
    return String(res.json?.configuration_hash ?? EMPTY_HASH)
  }

  private async apply(config: KongConfig): Promise<void> {
    const res = await this.admin('POST', '/config?flatten_errors=1', config)
    if (res.status !== 201 && res.status !== 200) {
      // Only names and messages: the rejected entities themselves can hold API keys.
      const errors =
        (res.json?.flattened_errors as
          | {
              entity_type?: string
              entity_name?: string
              errors?: { field?: string; message?: string }[]
            }[]
          | undefined) ?? []
      const summary = errors
        .slice(0, 5)
        .map(
          (e) =>
            `${e.entity_type ?? '?'} ${e.entity_name ?? '?'}: ${(e.errors ?? []).map((x) => `${x.field ?? ''} ${x.message ?? ''}`.trim()).join(', ')}`
        )
        .join('; ')
      throw new Error(
        `Kong rejected the config (${res.status}): ${summary || String(res.json?.message ?? 'no details')}`
      )
    }
    this.lastGood = { config, hash: await this.currentHash() }
    this.log('kong.applied', {
      services: config.services.length,
      consumers: config.consumers.length,
      hash: this.lastGood.hash,
    })
  }

  sync(): Promise<void> {
    return this.serial(async () => {
      const config = this.opts.render(await this.opts.load())
      await this.apply(config)
    })
  }

  /** Re-applies when Kong's running config is not the last one applied. */
  reconcile(): Promise<void> {
    return this.serial(async () => {
      const hash = await this.currentHash()
      if (this.lastGood && hash === this.lastGood.hash) return
      this.log('kong.drift', { kong_hash: hash, last_applied: this.lastGood?.hash ?? null })
      try {
        await this.apply(this.opts.render(await this.opts.load()))
      } catch (err) {
        if (!this.lastGood) throw err
        this.log('kong.render_failed_using_last_good', { error: String(err) })
        await this.apply(this.lastGood.config)
      }
    })
  }
}
