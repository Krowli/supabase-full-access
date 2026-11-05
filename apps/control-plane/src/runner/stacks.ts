import { randomInt } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  buildStack,
  PROJECT_REF,
  STACK_ENV_KEYS,
  STACK_ID,
  stackEnvFile,
  StackInputError,
  StackNotFoundError,
} from './stack.ts'

export { StackInputError, StackNotFoundError }

/** What the runner asks of Docker. src/runner/docker.ts runs the docker CLI; tests use a fake. */
export interface Docker {
  /** `docker compose -p <id> --project-directory <dir> -f <dir>/compose.yaml <args>`; returns stdout. */
  compose(id: string, dir: string, args: string[]): Promise<string>
  ensureNetwork(name: string): Promise<void>
  removeNetwork(name: string): Promise<void>
  /** Attaches the container to the network under the alias, unless it is attached already. */
  attach(container: string, network: string, alias: string): Promise<void>
  /** Whether any container carries the compose project label <id> (a stack Coolify made). */
  projectHasContainers(id: string): Promise<boolean>
}

export type StackMeta = { id: string; ref: string; name: string }
export type StackState = StackMeta & { status: string }

export type StacksConfig = {
  /** One directory per stack: meta.json, .env (mode 600), compose.yaml and its bound files. */
  dir: string
  /** The network the shared services reach the projects on (`coolify`, a name Coolify left). */
  sharedNetwork: string
  /** The project template rendered for a ref (src/template.ts). */
  render: (ref: string) => string
  docker: Docker
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const newId = () => Array.from({ length: 24 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('')

type PsLine = { Service?: string; State?: string; Health?: string }

/**
 * The aggregate status in the words the provisioner reads (the ones Coolify used): `running:healthy`
 * when every container runs and none is unhealthy or starting, `running:unhealthy` / `starting:unhealthy`
 * otherwise, `exited` when nothing runs.
 */
export function stackStatus(psJsonLines: string): string {
  const rows: PsLine[] = psJsonLines
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      const parsed = JSON.parse(l)
      return Array.isArray(parsed) ? parsed : [parsed]
    })
  if (!rows.length || !rows.some((r) => r.State === 'running')) return 'exited'
  if (rows.some((r) => r.Health === 'starting')) return 'starting:unhealthy'
  if (rows.every((r) => r.State === 'running' && (!r.Health || r.Health === 'healthy'))) return 'running:healthy'
  return 'running:unhealthy'
}

/**
 * The project stacks on this server, run with docker compose. Only the template is ever deployed: a
 * caller names a ref and gives the project's secrets, it never hands over compose text, so whoever can
 * call the runner can create, restart and delete project stacks and nothing else.
 */
export class Stacks {
  private config: StacksConfig

  constructor(config: StacksConfig) {
    this.config = config
  }

  private stackDir(id: string): string {
    if (!STACK_ID.test(id)) throw new StackInputError(`Invalid stack id ${id}`)
    return join(this.config.dir, id)
  }

  private async meta(id: string): Promise<StackMeta | null> {
    try {
      return JSON.parse(await readFile(join(this.stackDir(id), 'meta.json'), 'utf8')) as StackMeta
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  private async must(id: string): Promise<StackMeta> {
    const meta = await this.meta(id)
    if (!meta) throw new StackNotFoundError(`No stack ${id}`)
    return meta
  }

  async find(ref: string): Promise<string | null> {
    if (!PROJECT_REF.test(ref)) throw new StackInputError(`Invalid project ref ${ref}`)
    let ids: string[]
    try {
      ids = await readdir(this.config.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    for (const id of ids.filter((i) => STACK_ID.test(i))) {
      if ((await this.meta(id))?.ref === ref) return id
    }
    return null
  }

  /**
   * Registers the stack of a ref (or returns the one it has). `adoptId` takes over a stack Coolify
   * made under that id, in place: allowed only when containers of that compose project exist.
   */
  async create(ref: string, name: string, adoptId?: string): Promise<string> {
    const existing = await this.find(ref)
    if (existing) return existing
    if (typeof name !== 'string' || name.length > 200) throw new StackInputError('Invalid name')
    let id = newId()
    if (adoptId !== undefined) {
      this.stackDir(adoptId)
      if (!(await this.config.docker.projectHasContainers(adoptId)))
        throw new StackInputError(`No containers of compose project ${adoptId} to take over`)
      id = adoptId
    }
    const dir = this.stackDir(id)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ id, ref, name } satisfies StackMeta))
    return id
  }

  async get(id: string): Promise<StackState | null> {
    const meta = await this.meta(id)
    if (!meta) return null
    const ps = await this.config.docker.compose(id, this.stackDir(id), ['ps', '-a', '--format', 'json'])
    return { ...meta, status: stackStatus(ps) }
  }

  /** Adds or replaces variables, like Coolify's bulk env update; the file stays readable by root only. */
  async setEnvs(id: string, envs: Record<string, string>): Promise<void> {
    await this.must(id)
    const path = join(this.stackDir(id), '.env')
    const current: Record<string, string> = {}
    try {
      for (const line of (await readFile(path, 'utf8')).split('\n')) {
        const at = line.indexOf('=')
        if (at > 0) current[line.slice(0, at)] = line.slice(at + 1)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const text = stackEnvFile({ ...current, ...envs })
    await writeFile(path, text, { mode: 0o600 })
    await chmod(path, 0o600)
  }

  /** compose.yaml and the bound files from the current template. */
  private async writeFiles(meta: StackMeta): Promise<string[]> {
    const dir = this.stackDir(meta.id)
    const stack = buildStack(this.config.render(meta.ref), meta.id)
    for (const file of stack.files) {
      await mkdir(dirname(join(dir, file.path)), { recursive: true })
      await writeFile(join(dir, file.path), file.content)
    }
    await writeFile(join(dir, 'compose.yaml'), stack.compose)
    return stack.containers
  }

  private async up(meta: StackMeta, extra: string[] = []): Promise<void> {
    // compose fills a missing ${NAME} with an empty string: a stack started without its secrets
    // would run (or, taken over, restart) with empty passwords. Refuse instead.
    let env = ''
    try {
      env = await readFile(join(this.stackDir(meta.id), '.env'), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const have = new Set(env.split('\n').map((l) => l.slice(0, l.indexOf('='))))
    const missing = STACK_ENV_KEYS.filter((k) => !have.has(k))
    if (missing.length) throw new StackInputError(`Stack ${meta.id} lacks ${missing.join(', ')}`)
    const containers = await this.writeFiles(meta)
    const { docker, sharedNetwork } = this.config
    await docker.ensureNetwork(meta.id)
    await docker.compose(meta.id, this.stackDir(meta.id), ['up', '-d', '--remove-orphans', ...extra])
    for (const container of containers) await docker.attach(container, sharedNetwork, container)
  }

  async start(id: string): Promise<void> {
    await this.up(await this.must(id))
  }

  /** Writes the current template; it takes effect on the next start or restart (as with Coolify). */
  async update(id: string): Promise<void> {
    await this.writeFiles(await this.must(id))
  }

  /** Applies the current template and restarts every container (data and settings stay). */
  async restart(id: string): Promise<void> {
    const meta = await this.must(id)
    await this.up(meta)
    await this.config.docker.compose(id, this.stackDir(id), ['restart'])
  }

  /** Removes the containers, the stack's volumes and network, and its directory. */
  async delete(id: string): Promise<void> {
    const meta = await this.must(id)
    await this.writeFiles(meta)
    await this.config.docker.compose(id, this.stackDir(id), ['down', '--volumes', '--remove-orphans'])
    await this.config.docker.removeNetwork(id)
    await rm(this.stackDir(id), { recursive: true, force: true })
  }
}

