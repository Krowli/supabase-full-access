import type { Coolify } from './coolify.ts'

export type RunnerConfig = { url: string; token: string }

export class RunnerError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * The provisioner's stack backend over the runner (src/runner), instead of Coolify. The runner
 * renders the project template itself: the compose text the provisioner passes to createService and
 * updateCompose is not sent, so the control plane can deploy the template and nothing else. The
 * runner attaches every stack to the shared network, so connectToDockerNetwork has nothing to do.
 */
export function createRunnerClient(config: RunnerConfig): Coolify {
  const base = config.url.replace(/\/+$/, '')

  // Bodies carry secrets (envs): never logged. Start and restart pull images: up to 10 minutes.
  async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T | null> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 404) return null
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300)
      throw new RunnerError(`Runner ${method} ${path.split('?')[0]} -> ${res.status}: ${text}`, res.status)
    }
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  }
  const stack = (id: string) => `/stacks/${encodeURIComponent(id)}`
  const long = 10 * 60_000

  return {
    async findServiceByName(name) {
      return (await call<{ id: string }>('GET', `/stacks?ref=${encodeURIComponent(name)}`))?.id ?? null
    },
    async createService(name, description) {
      const res = await call<{ id: string }>('POST', '/stacks', { ref: name, name: description })
      if (!res?.id) throw new RunnerError('Runner POST /stacks returned no id', 0)
      return res.id
    },
    async getService(uuid) {
      const res = await call<{ id: string; status: string }>('GET', stack(uuid))
      return res ? { uuid: res.id, status: res.status, connectToDockerNetwork: true } : null
    },
    async connectToDockerNetwork() {},
    async setEnvs(uuid, envs) {
      await call('PUT', `${stack(uuid)}/envs`, { envs })
    },
    async start(uuid) {
      await call('POST', `${stack(uuid)}/start`, undefined, long)
    },
    async updateCompose(uuid) {
      await call('POST', `${stack(uuid)}/update`)
    },
    async restart(uuid) {
      await call('POST', `${stack(uuid)}/restart`, undefined, long)
    },
    async deleteService(uuid) {
      await call('DELETE', stack(uuid), undefined, long)
    },
  }
}
