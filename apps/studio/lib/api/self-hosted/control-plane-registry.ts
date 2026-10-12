import { z } from 'zod'

/**
 * The project registry as the control plane (`apps/control-plane`, branch `platform/cp-service`)
 * serves it, turned into the entries `project-context.ts` resolves requests with.
 *
 * Two calls, both with `Authorization: Bearer <token>`:
 *
 * - `GET /projects` lists every project without secrets: `ref`, `name`, `status`,
 *   `coolify_service_uuid` (null until Coolify has created the stack) and `created_at`.
 * - `GET /projects/<ref>/secrets` answers `db_password`, `jwt_secret`, `anon_key` and `service_key`.
 *
 * Each project becomes the same `env` a hand-written registry file holds (deploy/platform/SPEC.md §9):
 *
 * - `POSTGRES_HOST` is the project's db container on the shared `coolify` network,
 *   `supabase-db-<coolify_service_uuid>` (SPEC.md §8).
 * - `SUPABASE_URL` and `SUPABASE_PUBLIC_URL` are its public gateway, `https://<ref>.<suffix>`
 *   (SPEC.md §10).
 *
 * A project the control plane has not given a stack yet has no uuid, so it gets no database host
 * and no keys: it can be listed and polled for its status, and every backend read for it fails
 * (`project-context.ts`, `projectEnv`) rather than reaching another project's. A project being
 * deleted (`DELETING`) is treated the same way.
 */

export type ControlPlaneConfig = {
  url: string
  token: string
  domainSuffix: string
}

export type ControlPlaneProject = {
  ref: string
  name: string
  /** A platform status: the dashboard renders `COMING_UP` as the building screen. */
  status: string
  insertedAt?: string
  env: Record<string, string>
}

/** The control plane's lifecycle, in the statuses the dashboard already knows. */
const STATUS: Record<string, string> = {
  CREATING: 'COMING_UP',
  COMING_UP: 'COMING_UP',
  ACTIVE_HEALTHY: 'ACTIVE_HEALTHY',
  FAILED: 'INIT_FAILED',
  // Being deleted, or a delete stopped at a step (the control plane's next DELETE continues it).
  DELETING: 'GOING_DOWN',
}

/**
 * The control plane is tearing it down: nothing may read its backends, and its secrets go with its
 * rows at the end of the delete, so they are not asked for.
 */
const DELETING = 'DELETING'

/** A control-plane status as the dashboard knows it. */
export const platformStatus = (status: string): string => STATUS[status] ?? 'UNKNOWN'

/** How long one call may take. Studio serves the last good registry while the control plane is slow. */
const REQUEST_TIMEOUT_MS = 5_000

// A ref is a host label and a directory name (`project-context.ts`); a Coolify uuid becomes part of
// a container host name. Neither may carry anything that would turn either into another path or host.
const label = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)

const projectsSchema = z.array(
  z.object({
    ref: label.refine((ref) => ref !== 'default', 'the control plane cannot own default'),
    name: z.string(),
    status: z.string(),
    coolify_service_uuid: label.nullable(),
    created_at: z.string().optional(),
  })
)

const secretsSchema = z.object({
  db_password: z.string().min(1),
  jwt_secret: z.string().min(1),
  anon_key: z.string().min(1),
  service_key: z.string().min(1),
})

export class ControlPlaneError extends Error {
  /** What a Studio route answers with for this failure: the control plane's own 4xx, else 502. */
  readonly status: number

  constructor(message: string, status = 502) {
    super(message)
    this.name = 'ControlPlaneError'
    this.status = status
  }
}

/**
 * The control plane's refusals that are about the request, not about Studio or the control plane
 * itself. Their `{ error }` message is meant for the user (a bad name, a project being provisioned),
 * so a write passes it on with the same status.
 */
const REQUEST_ERRORS = new Set([400, 404, 409])

async function errorMessage(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json()
    const error = (body as { error?: unknown } | null)?.error
    return typeof error === 'string' ? error.slice(0, 200) : undefined
  } catch {
    return undefined
  }
}

/** One call. A failure names the method, the path and the status, never the token. */
async function requestJson(
  config: ControlPlaneConfig,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  { body, timeoutMs = REQUEST_TIMEOUT_MS }: { body?: unknown; timeoutMs?: number } = {}
): Promise<unknown> {
  const url = `${config.url.replace(/\/+$/, '')}${path}`
  const call = `control plane ${method} ${path}`
  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'error'
    throw new ControlPlaneError(`${call} failed: ${reason}`)
  }
  if (!response.ok) {
    // A read never quotes a body: the registry's answers carry secrets.
    const message =
      method !== 'GET' && REQUEST_ERRORS.has(response.status)
        ? await errorMessage(response)
        : undefined
    if (message) throw new ControlPlaneError(message, response.status)
    throw new ControlPlaneError(`${call} answered ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new ControlPlaneError(`${call} did not answer JSON`)
  }
}

const getJson = (config: ControlPlaneConfig, path: string) => requestJson(config, 'GET', path)

/** Parses with `schema`, naming the call and the fields at fault but never a value. */
function parse<T>(schema: z.ZodType<T>, value: unknown, path: string, method = 'GET'): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')
  throw new ControlPlaneError(`control plane ${method} ${path} is invalid at ${fields.join(', ')}`)
}

/** Every project the control plane holds, in its order (oldest first), with its secrets where it has a stack. */
export async function fetchControlPlaneProjects(
  config: ControlPlaneConfig
): Promise<ControlPlaneProject[]> {
  const projects = parse(projectsSchema, await getJson(config, '/projects'), '/projects')

  return Promise.all(
    projects.map(async (project) => {
      const publicUrl = `https://${project.ref}.${config.domainSuffix}`
      const env: Record<string, string> = {
        SUPABASE_URL: publicUrl,
        SUPABASE_PUBLIC_URL: publicUrl,
      }

      const uuid = project.coolify_service_uuid
      if (uuid && project.status !== DELETING) {
        const path = `/projects/${project.ref}/secrets`
        const secrets = parse(secretsSchema, await getJson(config, path), path)
        Object.assign(env, {
          POSTGRES_HOST: `supabase-db-${uuid}`,
          POSTGRES_PASSWORD: secrets.db_password,
          SUPABASE_ANON_KEY: secrets.anon_key,
          SUPABASE_SERVICE_KEY: secrets.service_key,
          AUTH_JWT_SECRET: secrets.jwt_secret,
        })
      }

      return {
        ref: project.ref,
        name: project.name,
        status: platformStatus(project.status),
        insertedAt: project.created_at,
        env,
      }
    })
  )
}

/**
 * Writes (deploy/platform/SPEC.md M6). The control plane answers each with the project's public
 * view: `ref`, `name`, `status`, `endpoint`, `created_at` and fields Studio does not read, no secrets.
 */
const projectViewSchema = z.object({
  ref: label,
  name: z.string(),
  status: z.string(),
  endpoint: z.string(),
  created_at: z.string().optional(),
})

export type ControlPlaneProjectView = z.infer<typeof projectViewSchema>

/** A create only inserts the project and starts provisioning in the background. */
const WRITE_TIMEOUT_MS = 15_000

/** A delete runs every step before it answers: gateway, tenants, the Coolify service, the bucket. */
const DELETE_TIMEOUT_MS = 120_000

/** `POST /projects {name}`: registers a project; the control plane generates its secrets. */
export async function createControlPlaneProject(
  config: ControlPlaneConfig,
  name: string
): Promise<ControlPlaneProjectView> {
  const body = await requestJson(config, 'POST', '/projects', {
    body: { name },
    timeoutMs: WRITE_TIMEOUT_MS,
  })
  return parse(projectViewSchema, body, '/projects', 'POST')
}

/** `POST /projects {ref}`: re-runs provisioning of a project that is not running. */
export async function retryControlPlaneProject(
  config: ControlPlaneConfig,
  ref: string
): Promise<ControlPlaneProjectView> {
  const body = await requestJson(config, 'POST', '/projects', {
    body: { ref },
    timeoutMs: WRITE_TIMEOUT_MS,
  })
  return parse(projectViewSchema, body, '/projects', 'POST')
}

/** `DELETE /projects/<ref>`: removes the project and everything provisioned for it. */
export async function deleteControlPlaneProject(
  config: ControlPlaneConfig,
  ref: string
): Promise<void> {
  await requestJson(config, 'DELETE', `/projects/${encodeURIComponent(ref)}`, {
    timeoutMs: DELETE_TIMEOUT_MS,
  })
}
