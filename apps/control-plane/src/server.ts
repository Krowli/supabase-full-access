import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { ConflictError, NotFoundError, routedProjects, type Provisioner } from './provisioner.ts'
import type { Project, Registry } from './registry.ts'

export type ServerDeps = {
  registry: Registry
  provisioner: Provisioner
  apiToken: string
  domainSuffix: string
  /** Hosts Kong routes besides the projects' (the dashboard), listed first at /hosts. */
  extraHosts?: string[]
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** The public shape of a project: no secrets. Internal hosts are how shared services reach it. */
export function projectView(p: Project, domainSuffix: string) {
  const u = p.coolify_service_uuid
  return {
    ref: p.ref,
    name: p.name,
    status: p.status,
    step: p.step,
    coolify_service_uuid: u,
    endpoint: `https://${p.ref}.${domainSuffix}`,
    internal: u
      ? {
          db_host: `supabase-db-${u}`,
          db_port: 5432,
          auth_url: `http://supabase-auth-${u}:9999`,
          rest_url: `http://supabase-rest-${u}:3000`,
          storage_url: `http://supabase-storage-${u}:5000`,
        }
      : null,
    created_at: p.created_at,
    updated_at: p.updated_at,
    last_error: p.last_error,
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new HttpError(413, 'Body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch {
    throw new HttpError(400, 'Body must be a JSON object')
  }
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const REF = /^[a-z]{20}$/

export function createApp(deps: ServerDeps): Server {
  const { registry, provisioner, domainSuffix } = deps
  const view = (p: Project) => projectView(p, domainSuffix)

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://local').pathname.replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'

    if (method === 'GET' && path === '/health') {
      await registry.ping()
      return send(res, 200, { ok: true })
    }
    // Public hostnames only (no secrets): the gateway host polls this to request certificates.
    if (method === 'GET' && path === '/hosts') {
      const hosts = [
        ...(deps.extraHosts ?? []),
        ...routedProjects(await registry.list()).map((p) => `${p.ref}.${domainSuffix}`),
      ]
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      return res.end(hosts.map((h) => `${h}\n`).join(''))
    }
    if (!authorized(req, deps.apiToken)) throw new HttpError(401, 'Unauthorized')

    if (path === '/projects') {
      if (method === 'GET') return send(res, 200, (await registry.list()).map(view))
      if (method === 'POST') {
        const body = await readJson(req)
        // With `ref`: re-run provisioning of an existing project (after FAILED or a crash).
        if (body.ref !== undefined) {
          if (typeof body.ref !== 'string' || !REF.test(body.ref))
            throw new HttpError(400, 'Invalid ref')
          const project = await registry.get(body.ref)
          if (!project) throw new HttpError(404, 'Project not found')
          if (project.status !== 'ACTIVE_HEALTHY') void provisioner.provision(project.ref)
          return send(res, 202, view((await registry.get(project.ref)) ?? project))
        }
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name || name.length > 64) throw new HttpError(400, 'name is required (1-64 chars)')
        const { project } = await provisioner.create(name)
        return send(res, 201, view(project))
      }
      throw new HttpError(405, 'Method not allowed')
    }

    const match = /^\/projects\/([^/]+)(\/secrets|\/stack)?$/.exec(path)
    if (match) {
      const [, ref, sub] = match
      const secrets = sub === '/secrets'
      if (!REF.test(ref)) throw new HttpError(404, 'Project not found')
      if (sub === '/stack') {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed')
        // Rewrites the project's compose from the current template and restarts its stack.
        await provisioner.updateStack(ref)
        return send(res, 202, { ref, updated: true })
      }
      if (method === 'GET' && secrets) {
        const s = await registry.getSecrets(ref)
        if (!s) throw new HttpError(404, 'Project not found')
        return send(res, 200, { ref, ...s })
      }
      if (method === 'GET' && !sub) {
        const project = await registry.get(ref)
        if (!project) throw new HttpError(404, 'Project not found')
        return send(res, 200, view(project))
      }
      if (method === 'DELETE' && !sub) {
        await provisioner.delete(ref)
        return send(res, 200, { ref, deleted: true })
      }
      throw new HttpError(405, 'Method not allowed')
    }
    throw new HttpError(404, 'Not found')
  }

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status =
        err instanceof HttpError
          ? err.status
          : err instanceof NotFoundError
            ? 404
            : err instanceof ConflictError
              ? 409
              : 500
      if (status === 500) console.error(JSON.stringify({ event: 'http.error', error: String(err) }))
      send(res, status, { error: status === 500 ? 'Internal error' : (err as Error).message })
    })
  })
}
