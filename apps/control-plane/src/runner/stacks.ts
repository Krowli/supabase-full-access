import { randomInt } from 'node:crypto'
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  checkBundle,
  checkSecrets,
  FUNCTION_NAME,
  functionNames,
  secretsFile,
  writeBundle,
  type FunctionsBundle,
} from './functions.ts'
import { POSTGRES_VERSIONS } from '../template.ts'
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
  /** `docker exec [-i] -u <user> <container> <args>`, `input` on stdin; returns stdout. */
  exec(
    container: string,
    user: string,
    args: string[],
    input?: string,
    timeoutMs?: number
  ): Promise<string>
  /** `docker kill --signal <signal> <container>`. */
  signal(container: string, signal: string): Promise<void>
  /** The image the container runs. */
  imageOf(container: string): Promise<string>
  /** `docker run -d <args>`: a one-off container (src/runner/pitr.ts). */
  run(args: string[]): Promise<void>
  /** Removes the container and the volumes, those of them that exist. */
  remove(container: string, volumes: string[]): Promise<void>
  running(container: string): Promise<boolean>
  /** The last lines of the container's output. */
  logs(container: string, lines: number): Promise<string>
}

/**
 * meta.json of a stack. `postgres` is absent for stacks made before Postgres 17 (they run 15, the
 * template's image); `functions` is true once Edge Functions were deployed to it.
 */
export type StackMeta = {
  id: string
  ref: string
  name: string
  postgres?: '17'
  functions?: boolean
}
export type StackState = StackMeta & { status: string }

/** What `GET /stacks/<id>/functions` tells: the deployed functions and the secrets' names only. */
export type FunctionsState = {
  enabled: boolean
  functions: string[]
  verify_jwt: Record<string, boolean>
  secrets: string[]
}

const FUNCTIONS_SERVICE = 'supabase-functions'

export type StacksConfig = {
  /** One directory per stack: meta.json, .env (mode 600), compose.yaml and its bound files. */
  dir: string
  /** The network the shared services reach the projects on (`coolify`, a name Coolify left). */
  sharedNetwork: string
  /** The project template rendered for a ref (src/template.ts). */
  render: (ref: string) => string
  docker: Docker
  /** The database image of stacks made on Postgres 17; without it, none can be made. */
  postgres17Image?: string
  /** The Edge Functions router (deploy/platform/functions-main), copied into stacks with functions. */
  functionsMainDir?: string
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  )

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const newId = () =>
  Array.from({ length: 24 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('')

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
  if (rows.every((r) => r.State === 'running' && (!r.Health || r.Health === 'healthy')))
    return 'running:healthy'
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

  private async saveMeta(meta: StackMeta): Promise<void> {
    await writeFile(join(this.stackDir(meta.id), 'meta.json'), JSON.stringify(meta))
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
   * `postgres` is the major of a new stack's database (default 15, the template's).
   */
  async create(
    ref: string,
    name: string,
    adoptId?: string,
    postgres: string = '15'
  ): Promise<string> {
    const existing = await this.find(ref)
    if (existing) return existing
    if (typeof name !== 'string' || name.length > 200) throw new StackInputError('Invalid name')
    if (!(POSTGRES_VERSIONS as readonly string[]).includes(postgres))
      throw new StackInputError(`Postgres ${postgres} is not one of ${POSTGRES_VERSIONS.join(', ')}`)
    if (postgres === '17' && !this.config.postgres17Image)
      throw new StackInputError('This runner has no Postgres 17 image (PROJECT_POSTGRES17_IMAGE)')
    if (postgres === '17' && adoptId !== undefined)
      throw new StackInputError('A stack taken over from Coolify runs Postgres 15')
    let id = newId()
    if (adoptId !== undefined) {
      this.stackDir(adoptId)
      if (!(await this.config.docker.projectHasContainers(adoptId)))
        throw new StackInputError(`No containers of compose project ${adoptId} to take over`)
      id = adoptId
    }
    const dir = this.stackDir(id)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await this.saveMeta({ id, ref, name, ...(postgres === '17' ? { postgres } : {}) })
    return id
  }

  async has(id: string): Promise<boolean> {
    return (await this.meta(id)) !== null
  }

  async get(id: string): Promise<StackState | null> {
    const meta = await this.meta(id)
    if (!meta) return null
    // A stack registered but not started yet has no compose.yaml, and compose refuses to run
    // without one: nothing of it runs.
    if (!(await exists(join(this.stackDir(id), 'compose.yaml'))))
      return { ...meta, status: 'exited' }
    const ps = await this.config.docker.compose(id, this.stackDir(id), [
      'ps',
      '-a',
      '--format',
      'json',
    ])
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
    // Never the template's Postgres 15 image for a Postgres 17 stack: it would not start on the data.
    if (meta.postgres === '17' && !this.config.postgres17Image)
      throw new Error(`Stack ${meta.id} runs Postgres 17 and this runner has no image for it`)
    const stack = buildStack(this.config.render(meta.ref), meta.id, {
      postgresImage: meta.postgres === '17' ? this.config.postgres17Image : undefined,
      functions: meta.functions === true,
    })
    if (meta.functions) {
      if (!this.config.functionsMainDir) throw new Error('This runner has no Edge Functions router')
      await rm(join(dir, 'functions-main'), { recursive: true, force: true })
      await cp(this.config.functionsMainDir, join(dir, 'functions-main'), { recursive: true })
      await mkdir(join(dir, 'functions'), { recursive: true })
    }
    for (const file of stack.files) {
      await mkdir(dirname(join(dir, file.path)), { recursive: true })
      await writeFile(join(dir, file.path), file.content)
    }
    await writeFile(join(dir, 'compose.yaml'), stack.compose)
    return stack.containers
  }

  /** compose fills a missing ${NAME} with an empty string: refuse to start a stack without its secrets. */
  private async requireEnvs(meta: StackMeta): Promise<void> {
    let env = ''
    try {
      env = await readFile(join(this.stackDir(meta.id), '.env'), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const have = new Set(env.split('\n').map((l) => l.slice(0, l.indexOf('='))))
    const missing = STACK_ENV_KEYS.filter((k) => !have.has(k))
    if (missing.length) throw new StackInputError(`Stack ${meta.id} lacks ${missing.join(', ')}`)
  }

  private async up(meta: StackMeta, extra: string[] = []): Promise<void> {
    // A stack started without its secrets would run (or, taken over, restart) with empty passwords.
    await this.requireEnvs(meta)
    const containers = await this.writeFiles(meta)
    const { docker, sharedNetwork } = this.config
    const dir = this.stackDir(meta.id)
    await docker.ensureNetwork(meta.id)
    // Create (and, when the template changed, recreate) the containers without starting them, attach
    // them to the shared network, then start them: a container that crashes at once (a service
    // whose dependency is down) is attached all the same, and nothing runs unreachable meanwhile.
    await docker.compose(meta.id, dir, ['up', '--no-start', '--remove-orphans'])
    for (const container of containers) await docker.attach(container, sharedNetwork, container)
    await docker.compose(meta.id, dir, ['up', '-d', '--remove-orphans', ...extra])
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

  /**
   * (Re)creates the Edge Functions container alone and restarts it, so it serves the functions on disk
   * now: the rest of the stack is left as it runs (a template change reaches it at its next restart).
   */
  private async upFunctions(meta: StackMeta): Promise<void> {
    await this.requireEnvs(meta)
    await this.writeFiles(meta)
    const { docker, sharedNetwork } = this.config
    const dir = this.stackDir(meta.id)
    const container = `${FUNCTIONS_SERVICE}-${meta.id}`
    await docker.ensureNetwork(meta.id)
    await docker.compose(meta.id, dir, ['up', '--no-start', '--no-deps', FUNCTIONS_SERVICE])
    await docker.attach(container, sharedNetwork, container)
    await docker.compose(meta.id, dir, ['up', '-d', '--no-deps', FUNCTIONS_SERVICE])
    await docker.compose(meta.id, dir, ['restart', FUNCTIONS_SERVICE])
  }

  /** Deploys the project's Edge Functions (all of them: one left out is removed) and serves them. */
  async deployFunctions(id: string, input: { files?: unknown; verify_jwt?: unknown }): Promise<string[]> {
    const meta = await this.must(id)
    const bundle: FunctionsBundle = checkBundle(input)
    await writeBundle(this.stackDir(id), bundle)
    if (!meta.functions) await this.saveMeta({ ...meta, functions: true })
    await this.upFunctions({ ...meta, functions: true })
    return functionNames(bundle.files)
  }

  /** Replaces the functions' secrets, all of them; they apply at once when functions run. */
  async setFunctionSecrets(id: string, input: unknown): Promise<string[]> {
    const meta = await this.must(id)
    const secrets = checkSecrets(input)
    await writeFile(join(this.stackDir(id), 'functions.env'), secretsFile(secrets), { mode: 0o600 })
    await chmod(join(this.stackDir(id), 'functions.env'), 0o600)
    if (meta.functions) await this.upFunctions(meta)
    return Object.keys(secrets).sort()
  }

  async functions(id: string): Promise<FunctionsState> {
    const meta = await this.must(id)
    const dir = this.stackDir(id)
    const read = (name: string) =>
      readFile(join(dir, name), 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return ''
        throw err
      })
    const manifest = await read('functions/.platform.json')
    const names = meta.functions
      ? (await readdir(join(dir, 'functions'), { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      : []
    return {
      enabled: meta.functions === true,
      functions: names.filter((n) => FUNCTION_NAME.test(n)).sort(),
      verify_jwt: manifest ? JSON.parse(manifest).verify_jwt ?? {} : {},
      secrets: (await read('functions.env'))
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => l.slice(0, l.indexOf('=')))
        .sort(),
    }
  }

  /** Edge Functions off: the container, the functions, their secrets and module cache go. */
  async removeFunctions(id: string): Promise<void> {
    const meta = await this.must(id)
    await this.config.docker.remove(`${FUNCTIONS_SERVICE}-${id}`, [])
    const { functions: _, ...rest } = meta
    await this.saveMeta(rest)
    for (const name of ['functions', 'functions-main', 'functions-cache', 'functions.env'])
      await rm(join(this.stackDir(id), name), { recursive: true, force: true })
    if (await exists(join(this.stackDir(id), 'compose.yaml'))) await this.writeFiles(rest)
  }

  /** Removes the containers, the stack's volumes and network, and its directory. */
  async delete(id: string): Promise<void> {
    const meta = await this.must(id)
    await this.writeFiles(meta)
    await this.config.docker.compose(id, this.stackDir(id), [
      'down',
      '--volumes',
      '--remove-orphans',
    ])
    await this.config.docker.removeNetwork(id)
    await rm(this.stackDir(id), { recursive: true, force: true })
  }
}
