import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NextApiRequest, NextApiResponse } from 'next'
import { z } from 'zod'

import { DEFAULT_AUTH_JWT_SECRET } from './constants'

/**
 * Which project a self-hosted API request is for, and where that project's backends are.
 *
 * Self-hosted Studio was written for one project, so every backend it talks to — Postgres through
 * pg-meta, GoTrue, storage, PostgREST, the API keys and the JWT secret — is read from the container
 * environment. This module is the one place those reads happen. `apiWrapper` runs each handler
 * inside `withProjectContext`, which resolves the route's `ref` once, and every reader below answers
 * for that project.
 *
 * Off by default. With `STUDIO_PROJECT_REGISTRY` unset, `projectEnv(name)` is `process.env[name]`
 * and `withProjectContext` calls the handler directly, so a single-project Studio behaves exactly as
 * it did before this file existed.
 *
 * With it set, it names a JSON file:
 *
 *     { "projectsDir": "/data/pieowl/projects",
 *       "projects": { "default": {}, "<ref>": { "name": "…", "env": { "POSTGRES_HOST": "…", … } } } }
 *
 * - `default` is always a project. Its values come from its `env` entry, else from the container
 *   environment, which is what it ran on before.
 * - Any other project gets nothing from the container environment. The names in `REQUIRED_ENV` must
 *   be in its entry, and the rest either come from its entry, are derived from its ref
 *   (`DERIVED_ENV`), or are left unset so the reader's own default applies. A project that is
 *   missing its database host must fail, not quietly open `default`'s database.
 * - An unknown ref is a 404, and a reader called outside any request for a project throws.
 */

export const DEFAULT_PROJECT_REF = 'default'

/** Re-read the registry at most this often, so a project added to the file shows up without a restart. */
const REGISTRY_TTL_MS = 30_000

/** The environment names whose value belongs to one project. Every other name Studio reads is shared. */
const PROJECT_ENV_NAMES = [
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_DB',
  'POSTGRES_PASSWORD',
  'POSTGRES_USER_READ_WRITE',
  'POSTGRES_USER_READ_ONLY',
  'SUPABASE_URL',
  'SUPABASE_PUBLIC_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'AUTH_JWT_SECRET',
  'POOLER_TENANT_ID',
  'REALTIME_TENANT_ID',
  'STUDIO_AUTH_STATE_DIR',
  'STORAGE_CONFIG_DIR',
  'PGRST_DB_EXTRA_SEARCH_PATH',
  'PGRST_DB_MAX_ROWS',
  'UPLOAD_FILE_SIZE_LIMIT',
  'ENABLE_IMAGE_TRANSFORMATION',
  'S3_PROTOCOL_ENABLED',
  'S3_PROTOCOL_ACCESS_KEY_ID',
  'S3_PROTOCOL_ACCESS_KEY_SECRET',
] as const

/** `GOTRUE_*` covers the auth-config directory and the GoTrue settings Studio mirrors. */
export type ProjectEnvName = (typeof PROJECT_ENV_NAMES)[number] | `GOTRUE_${string}`

/** What a project other than `default` cannot run without; each would otherwise fall back to a value that names `default`'s backend. */
const REQUIRED_ENV = [
  'POSTGRES_HOST',
  'POSTGRES_PASSWORD',
  'SUPABASE_URL',
  'SUPABASE_PUBLIC_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_KEY',
  'AUTH_JWT_SECRET',
] as const

/** Values a project other than `default` gets from its ref when its entry does not set them. */
const DERIVED_ENV: Partial<Record<ProjectEnvName, (ref: string, projectsDir: string) => string>> = {
  // Supavisor and Realtime are shared, and a project is a tenant of each under its ref.
  POOLER_TENANT_ID: (ref) => ref,
  REALTIME_TENANT_ID: (ref) => ref,
  // The files Studio writes for a project's GoTrue and storage-api, and its own record of them.
  GOTRUE_CONFIG_DIR: (ref, dir) => join(dir, ref, 'gotrue'),
  STORAGE_CONFIG_DIR: (ref, dir) => join(dir, ref, 'storage'),
  STUDIO_AUTH_STATE_DIR: (ref, dir) => join(dir, ref, 'state'),
}

const isProjectEnvName = (name: string): name is ProjectEnvName =>
  name.startsWith('GOTRUE_') || (PROJECT_ENV_NAMES as readonly string[]).includes(name)

// A ref is a Realtime tenant (the first label of a Host header) and a directory name, so it has to
// be both: lowercase letters, digits and hyphens, starting with a letter or digit.
const refSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'a ref is 1-63 lowercase letters, digits or hyphens')

const projectSchema = z
  .object({
    name: z.string().optional(),
    env: z
      .record(
        z.string().refine(isProjectEnvName, (name) => ({
          message: `${name} is not a per-project setting`,
        })),
        z.string()
      )
      .default({}),
  })
  .strict()

const registrySchema = z
  .object({
    projectsDir: z.string().default('/data/pieowl/projects'),
    projects: z.record(refSchema, projectSchema),
  })
  .strict()
  .superRefine((registry, ctx) => {
    for (const [ref, project] of Object.entries(registry.projects)) {
      if (ref === DEFAULT_PROJECT_REF) continue
      const missing = REQUIRED_ENV.filter((name) => !project.env[name])
      if (missing.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['projects', ref, 'env'],
          message: `project ${ref} must set ${missing.join(', ')}`,
        })
      }
    }
  })

export type ResolvedProject = {
  ref: string
  name?: string
  env: Partial<Record<string, string>>
  projectsDir: string
}

/** A request could not be tied to a project. `toJSON` is what lets `apiWrapper`'s `{ error }` carry the message. */
export class ProjectContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectContextError'
  }

  toJSON() {
    return { message: this.message }
  }
}

export class ProjectNotFoundError extends ProjectContextError {
  constructor(ref: string) {
    super(`Project ${ref} not found`)
    this.name = 'ProjectNotFoundError'
  }
}

export function isMultiProject(): boolean {
  return Boolean(process.env.STUDIO_PROJECT_REGISTRY)
}

let cache: { path: string; loadedAt: number; projects: Map<string, ResolvedProject> } | undefined

function loadRegistry(path: string): Map<string, ResolvedProject> {
  if (cache?.path === path && Date.now() - cache.loadedAt < REGISTRY_TTL_MS) return cache.projects

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    // The file holds every project's secrets, so neither the parser's message (which quotes the
    // text around the fault) nor the file itself goes into an error that can reach a response.
    if (error instanceof SyntaxError) {
      throw new ProjectContextError(`Project registry ${path} is not valid JSON`)
    }
    throw new ProjectContextError(`Project registry ${path} cannot be read`)
  }

  const parsed = registrySchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) =>
      issue.code === z.ZodIssueCode.custom
        ? issue.message
        : `${issue.path.join('.')}: ${issue.message}`
    )
    throw new ProjectContextError(`Project registry ${path} is invalid: ${issues.join('; ')}`)
  }

  const { projectsDir, projects } = parsed.data
  const resolved = new Map<string, ResolvedProject>([
    [DEFAULT_PROJECT_REF, { ref: DEFAULT_PROJECT_REF, env: {}, projectsDir }],
  ])
  for (const [ref, project] of Object.entries(projects)) {
    resolved.set(ref, { ref, name: project.name, env: project.env, projectsDir })
  }

  cache = { path, loadedAt: Date.now(), projects: resolved }
  return resolved
}

function findProject(ref: string): ResolvedProject {
  const project = loadRegistry(process.env.STUDIO_PROJECT_REGISTRY!).get(ref)
  if (!project) throw new ProjectNotFoundError(ref)
  return project
}

const storage = new AsyncLocalStorage<ResolvedProject>()

/** Runs `fn` as project `ref`. Throws `ProjectNotFoundError` for a ref the registry does not hold. */
export function runWithProject<T>(ref: string, fn: () => T): T {
  if (!isMultiProject()) return fn()
  return storage.run(findProject(ref), fn)
}

/** The route's `[ref]`, else the `projectRef` the AI routes carry in their body. */
function requestRef(req: NextApiRequest): string | undefined {
  if (typeof req.query.ref === 'string') return req.query.ref
  const bodyRef = req.body?.projectRef
  return typeof bodyRef === 'string' ? bodyRef : undefined
}

/**
 * Runs an API handler as the project its request names. Called by `apiWrapper` for every route.
 *
 * A request that names no project runs without one; any reader it reaches throws rather than
 * picking `default`. A request that names a project the registry does not hold is a 404.
 */
export async function withProjectContext<T>(
  req: NextApiRequest,
  res: NextApiResponse,
  fn: () => Promise<T>
): Promise<T | void> {
  if (!isMultiProject()) return fn()

  const ref = requestRef(req)
  if (ref === undefined) return fn()

  let project: ResolvedProject
  try {
    project = findProject(ref)
  } catch (error) {
    if (!(error instanceof ProjectNotFoundError)) throw error
    return res.status(404).json({ error: { message: error.message } })
  }
  return storage.run(project, fn)
}

function currentProject(): ResolvedProject {
  const project = storage.getStore()
  if (!project) {
    throw new ProjectContextError(
      'No project in this request: Studio is multi-project and this route does not name one'
    )
  }
  return project
}

/** The ref of the project this request is for. Always `default` when Studio is single-project. */
export function currentProjectRef(): string {
  return isMultiProject() ? currentProject().ref : DEFAULT_PROJECT_REF
}

/** The registry's name for this request's project, if it gives one. */
export function currentProjectName(): string | undefined {
  return isMultiProject() ? currentProject().name : undefined
}

/** The value of a per-project environment name for this request's project. */
export function projectEnv(name: ProjectEnvName): string | undefined {
  if (!isMultiProject()) return process.env[name]

  const project = currentProject()
  if (project.ref === DEFAULT_PROJECT_REF) return project.env[name] ?? process.env[name]
  return project.env[name] ?? DERIVED_ENV[name]?.(project.ref, project.projectsDir)
}

/** This project's Postgres, with the defaults `constants.ts` applies to the container environment. */
export function projectPostgres() {
  return {
    host: projectEnv('POSTGRES_HOST') || 'db',
    port: parseInt(projectEnv('POSTGRES_PORT') || '5432', 10),
    database: projectEnv('POSTGRES_DB') || 'postgres',
    password: projectEnv('POSTGRES_PASSWORD') || 'postgres',
    userReadWrite: projectEnv('POSTGRES_USER_READ_WRITE') || 'supabase_admin',
    userReadOnly: projectEnv('POSTGRES_USER_READ_ONLY') || 'supabase_read_only_user',
  }
}

/** The secret this project's GoTrue, PostgREST and storage-api sign and verify user tokens with. */
export function projectJwtSecret(): string {
  return projectEnv('AUTH_JWT_SECRET') || DEFAULT_AUTH_JWT_SECRET
}

/**
 * The secret Studio signs its calls to the shared Supavisor and Realtime admin APIs with — their
 * `API_JWT_SECRET`. One stack used to share it with its only project, so it still defaults to
 * `AUTH_JWT_SECRET`; once projects have their own secrets, `PLATFORM_ADMIN_JWT_SECRET` sets it.
 */
export function adminJwtSecret(): string {
  return (
    process.env.PLATFORM_ADMIN_JWT_SECRET || process.env.AUTH_JWT_SECRET || DEFAULT_AUTH_JWT_SECRET
  )
}
