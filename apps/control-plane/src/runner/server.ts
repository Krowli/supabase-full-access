import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { StackInputError, StackNotFoundError, type Stacks } from './stacks.ts'

/**
 * The runner's API, for the control plane only (not published; bearer token). It mirrors the few
 * Coolify calls the provisioner makes, with refs and secrets as input and no compose text:
 *
 *   GET    /health                    no token; {"ok":true}
 *   GET    /stacks?ref=<ref>          {"id"} or 404
 *   POST   /stacks {ref, name}        {"id"}: the existing stack of the ref, or a new one
 *   GET    /stacks/<id>               {"id","ref","name","status"} or 404
 *   PUT    /stacks/<id>/envs {envs}   only the project secrets the template reads
 *   POST   /stacks/<id>/start | /update | /restart
 *   DELETE /stacks/<id>               containers, volumes, network and files
 */
export type RunnerServerDeps = { stacks: Stacks; token: string; log?: (event: string, fields: Record<string, unknown>) => void }

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function send(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(body === undefined ? undefined : JSON.stringify(body))
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

const STACK_PATH = /^\/stacks\/([a-z0-9]{24})(?:\/(envs|start|update|restart))?$/

export function createRunnerServer(deps: RunnerServerDeps): Server {
  const { stacks, token } = deps
  const log = deps.log ?? (() => {})
  if (token.length < 32) throw new Error('RUNNER_TOKEN must be at least 32 characters')

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://runner')
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true })
      if (!authorized(req, token)) throw new HttpError(401, 'Unauthorized')

      if (url.pathname === '/stacks') {
        if (req.method === 'GET') {
          const id = await stacks.find(url.searchParams.get('ref') ?? '')
          return id ? send(res, 200, { id }) : send(res, 404, { error: 'No stack for this ref' })
        }
        if (req.method === 'POST') {
          const body = await readJson(req)
          const id = await stacks.create(String(body.ref ?? ''), String(body.name ?? ''))
          log('stack.created', { id, ref: body.ref })
          return send(res, 200, { id })
        }
      }

      const m = STACK_PATH.exec(url.pathname)
      if (m) {
        const [, id, action] = m
        if (!action && req.method === 'GET') {
          const state = await stacks.get(id)
          return state ? send(res, 200, state) : send(res, 404, { error: 'No such stack' })
        }
        if (!action && req.method === 'DELETE') {
          await stacks.delete(id)
          log('stack.deleted', { id })
          return send(res, 204)
        }
        if (action === 'envs' && req.method === 'PUT') {
          const { envs } = await readJson(req)
          if (typeof envs !== 'object' || envs === null || Array.isArray(envs))
            throw new HttpError(400, 'envs must be an object')
          await stacks.setEnvs(id, Object.fromEntries(Object.entries(envs).map(([k, v]) => [k, String(v)])))
          log('stack.envs_set', { id, keys: Object.keys(envs) })
          return send(res, 204)
        }
        if (action && action !== 'envs' && req.method === 'POST') {
          await stacks[action as 'start' | 'update' | 'restart'](id)
          log(`stack.${action}`, { id })
          return send(res, 204)
        }
      }
      throw new HttpError(404, 'Not found')
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message })
      if (err instanceof StackInputError) return send(res, 400, { error: err.message })
      if (err instanceof StackNotFoundError) return send(res, 404, { error: err.message })
      const message = err instanceof Error ? err.message : String(err)
      log('runner.error', { method: req.method, path: url.pathname, error: message.slice(0, 500) })
      return send(res, 500, { error: message.slice(0, 500) })
    }
  })
}
