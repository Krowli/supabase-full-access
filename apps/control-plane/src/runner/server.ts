import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { MAX_BUNDLE_BYTES } from './functions.ts'
import type { Pitr } from './pitr.ts'
import { StackInputError, StackNotFoundError, type Stacks } from './stacks.ts'

/**
 * The runner's API, for the control plane only (not published; bearer token). It mirrors the few
 * Coolify calls the provisioner makes, with refs and secrets as input and no compose text:
 *
 *   GET    /health                    no token; {"ok":true}
 *   GET    /stacks?ref=<ref>          {"id"} or 404
 *   POST   /stacks {ref, name, postgres?}  {"id"}: the existing stack of the ref, or a new one on
 *                                      Postgres `postgres` ("15", the default, or "17")
 *   GET    /stacks/<id>               {"id","ref","name","postgres"?,"functions"?,"status"} or 404
 *   PUT    /stacks/<id>/envs {envs}   only the project secrets the template reads
 *   POST   /stacks/<id>/start | /update | /restart
 *   DELETE /stacks/<id>               containers, volumes, network and files
 *
 * Point-in-time recovery of the stack's database (src/runner/pitr.ts), for the backup service:
 *
 *   PUT    /stacks/<id>/wal-g {settings}            wal-g's files in the config volume, then a reload
 *   DELETE /stacks/<id>/wal-g                       PITR off (archiving stops fully at the next restart)
 *   POST   /stacks/<id>/wal-g/backup {keep_full}    a base backup; {"backups"}
 *   GET    /stacks/<id>/wal-g/backups               {"backups"}, oldest first
 *   POST   /stacks/<id>/pitr-scratch {backup, target_time}   a read-only copy at that moment; {"host"}
 *   DELETE /stacks/<id>/pitr-scratch                the copy and its volume
 *
 * Edge Functions of the stack (src/runner/functions.ts), for the control plane:
 *
 *   PUT    /stacks/<id>/functions {files, verify_jwt}   all of them, then served; {"functions"}
 *   GET    /stacks/<id>/functions                       {"enabled","functions","verify_jwt","secrets"}
 *   DELETE /stacks/<id>/functions                       off: container, files and secrets go
 *   PUT    /stacks/<id>/functions/secrets {secrets}     all of them; {"secrets"} (names)
 */
export type RunnerServerDeps = {
  stacks: Stacks
  pitr: Pitr
  token: string
  log?: (event: string, fields: Record<string, unknown>) => void
}

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

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'Body too large')
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

const STACK_PATH =
  /^\/stacks\/([a-z0-9]{24})(?:\/(envs|start|update|restart|wal-g|wal-g\/backup|wal-g\/backups|pitr-scratch|functions|functions\/secrets))?$/

export function createRunnerServer(deps: RunnerServerDeps): Server {
  const { stacks, pitr, token } = deps
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
          const postgres = body.postgres === undefined ? undefined : String(body.postgres)
          const id = await stacks.create(String(body.ref ?? ''), String(body.name ?? ''), undefined, postgres)
          log('stack.created', { id, ref: body.ref, postgres: postgres ?? '15' })
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
          await pitr.dropScratch(id)
          await stacks.delete(id)
          log('stack.deleted', { id })
          return send(res, 204)
        }
        if (action === 'envs' && req.method === 'PUT') {
          const { envs } = await readJson(req)
          if (typeof envs !== 'object' || envs === null || Array.isArray(envs))
            throw new HttpError(400, 'envs must be an object')
          await stacks.setEnvs(
            id,
            Object.fromEntries(Object.entries(envs).map(([k, v]) => [k, String(v)]))
          )
          log('stack.envs_set', { id, keys: Object.keys(envs) })
          return send(res, 204)
        }
        if (
          (action === 'start' || action === 'update' || action === 'restart') &&
          req.method === 'POST'
        ) {
          await stacks[action](id)
          log(`stack.${action}`, { id })
          return send(res, 204)
        }
        // Bodies hold wal-g's keys: never logged.
        if (action === 'wal-g' && req.method === 'PUT') {
          await pitr.configure(id, (await readJson(req)).settings)
          log('pitr.configured', { id })
          return send(res, 204)
        }
        if (action === 'wal-g' && req.method === 'DELETE') {
          await pitr.disable(id)
          log('pitr.disabled', { id })
          return send(res, 204)
        }
        if (action === 'wal-g/backup' && req.method === 'POST') {
          const backups = await pitr.backup(id, Number((await readJson(req)).keep_full))
          log('pitr.backup_pushed', { id, backups: backups.length })
          return send(res, 200, { backups })
        }
        if (action === 'wal-g/backups' && req.method === 'GET')
          return send(res, 200, { backups: await pitr.backups(id) })
        if (action === 'pitr-scratch' && req.method === 'POST') {
          const body = await readJson(req)
          const host = await pitr.startScratch(
            id,
            String(body.backup ?? ''),
            String(body.target_time ?? '')
          )
          log('pitr.scratch_ready', { id, target_time: body.target_time })
          return send(res, 200, { host })
        }
        if (action === 'pitr-scratch' && req.method === 'DELETE') {
          await pitr.dropScratch(id)
          log('pitr.scratch_removed', { id })
          return send(res, 204)
        }
        // A deploy is the code (JSON escapes it: allow twice its size); secrets are never logged.
        if (action === 'functions' && req.method === 'PUT') {
          const functions = await stacks.deployFunctions(id, await readJson(req, 2 * MAX_BUNDLE_BYTES + 64 * 1024))
          log('functions.deployed', { id, functions })
          return send(res, 200, { functions })
        }
        if (action === 'functions' && req.method === 'GET') return send(res, 200, await stacks.functions(id))
        if (action === 'functions' && req.method === 'DELETE') {
          await stacks.removeFunctions(id)
          log('functions.removed', { id })
          return send(res, 204)
        }
        if (action === 'functions/secrets' && req.method === 'PUT') {
          const secrets = await stacks.setFunctionSecrets(id, (await readJson(req, 1024 * 1024)).secrets)
          log('functions.secrets_set', { id, secrets })
          return send(res, 200, { secrets })
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
