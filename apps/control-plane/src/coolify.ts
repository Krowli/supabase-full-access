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

/**
 * How the control plane finds its Coolify target. Installed as a Coolify application, it knows its
 * own uuid (COOLIFY_RESOURCE_UUID, which Coolify sets in every container of the stack) and takes the
 * project and server from that application; explicit uuids win.
 */
export type CoolifyTargetConfig = Omit<CoolifyConfig, 'projectUuid' | 'serverUuid'> & {
  projectUuid?: string
  serverUuid?: string
  resourceUuid?: string
}

export class CoolifyError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * The project and server for project stacks, and the project environment they go into, created
 * here when it is missing (Coolify answers 409 when it exists).
 */
export async function resolveCoolifyTarget(config: CoolifyTargetConfig): Promise<CoolifyConfig> {
  const { resourceUuid, ...rest } = config
  const call = createCall(config)
  let { projectUuid, serverUuid } = config
  if (!projectUuid || !serverUuid) {
    if (!resourceUuid) {
      throw new Error('Set COOLIFY_PROJECT_UUID and COOLIFY_SERVER_UUID, or run as a Coolify application')
    }
    const app = await call<{
      environment?: { project?: { uuid?: string } }
      destination?: { server?: { uuid?: string } }
    }>('GET', `/applications/${encodeURIComponent(resourceUuid)}`)
    if (!app) throw new CoolifyError(`Coolify has no application ${resourceUuid}`, 404)
    projectUuid ||= app.environment?.project?.uuid
    serverUuid ||= app.destination?.server?.uuid
    if (!projectUuid || !serverUuid) {
      throw new CoolifyError(`Coolify application ${resourceUuid} has no project or server`, 0)
    }
  }
  try {
    await call('POST', `/projects/${encodeURIComponent(projectUuid)}/environments`, {
      name: config.environment,
    })
  } catch (err) {
    if (!(err instanceof CoolifyError && err.status === 409)) throw err
  }
  return { ...rest, projectUuid, serverUuid }
}

function createCall(config: Pick<CoolifyConfig, 'url' | 'token'>) {
  const base = config.url.replace(/\/+$/, '')

  // Response bodies are never logged on success: env endpoints echo the values back.
  return async function call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
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
}

export function createCoolifyClient(config: CoolifyConfig): Coolify {
  const call = createCall(config)
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
