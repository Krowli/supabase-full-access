// Coolify API v1 (checked against Coolify 4.4.6). Only the calls the provisioner needs.

export type CoolifyService = {
  uuid: string
  /** Aggregate container status, e.g. `running:healthy`, `starting:unhealthy`, `exited`. */
  status: string
  connectToDockerNetwork: boolean
}

export interface Coolify {
  /** The uuid of the service with this name in the configured project environment, if any. */
  findServiceByName(name: string): Promise<string | null>
  createService(name: string, description: string, composeRaw: string): Promise<string>
  getService(uuid: string): Promise<CoolifyService | null>
  connectToDockerNetwork(uuid: string): Promise<void>
  setEnvs(uuid: string, envs: Record<string, string>): Promise<void>
  start(uuid: string): Promise<void>
  /** Queues deletion of the service, its volumes, networks and configuration. */
  deleteService(uuid: string): Promise<void>
}

export type CoolifyConfig = {
  url: string
  token: string
  projectUuid: string
  environment: string
  serverUuid: string
}

export class CoolifyError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export function createCoolifyClient(config: CoolifyConfig): Coolify {
  const base = config.url.replace(/\/+$/, '')

  // Response bodies are never logged on success: env endpoints echo the values back.
  async function call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    if (res.status === 404) return null
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300)
      throw new CoolifyError(
        `Coolify ${method} ${path.split('?')[0]} -> ${res.status}: ${text}`,
        res.status
      )
    }
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  }

  const svc = (uuid: string) => `/services/${encodeURIComponent(uuid)}`

  return {
    async findServiceByName(name) {
      const env = await call<{ services?: { uuid: string; name: string }[] }>(
        'GET',
        `/projects/${config.projectUuid}/${encodeURIComponent(config.environment)}`
      )
      if (!env) throw new CoolifyError('Coolify project or environment not found', 404)
      return env.services?.find((s) => s.name === name)?.uuid ?? null
    },

    async createService(name, description, composeRaw) {
      const res = await call<{ uuid: string }>('POST', '/services', {
        name,
        description,
        project_uuid: config.projectUuid,
        environment_name: config.environment,
        server_uuid: config.serverUuid,
        instant_deploy: false,
        docker_compose_raw: Buffer.from(composeRaw).toString('base64'),
      })
      if (!res?.uuid) throw new CoolifyError('Coolify POST /services returned no uuid', 0)
      return res.uuid
    },

    async getService(uuid) {
      const res = await call<{
        uuid: string
        status?: string
        connect_to_docker_network?: boolean
      }>('GET', svc(uuid))
      if (!res) return null
      return {
        uuid: res.uuid,
        status: res.status ?? 'unknown',
        connectToDockerNetwork: res.connect_to_docker_network === true,
      }
    },

    async connectToDockerNetwork(uuid) {
      await call('PATCH', svc(uuid), { connect_to_docker_network: true })
    },

    async setEnvs(uuid, envs) {
      // Bulk PATCH upserts: keys Coolify created while parsing the compose are updated, others added.
      const data = Object.entries(envs).map(([key, value]) => ({ key, value, is_literal: true }))
      await call('PATCH', `${svc(uuid)}/envs/bulk`, { data })
    },

    async start(uuid) {
      await call('POST', `${svc(uuid)}/start`)
    },

    async deleteService(uuid) {
      await call(
        'DELETE',
        `${svc(uuid)}?delete_configurations=true&delete_volumes=true&docker_cleanup=true&delete_connected_networks=true`
      )
    },
  }
}
