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
 * (`project-context.ts`, `projectEnv`) rather than reaching another project's.
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
}

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
  constructor(message: string) {
    super(message)
    this.name = 'ControlPlaneError'
  }
}

/** One call. A failure names the path and the status, never the token or a response body. */
async function getJson(config: ControlPlaneConfig, path: string): Promise<unknown> {
  const url = `${config.url.replace(/\/+$/, '')}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'error'
    throw new ControlPlaneError(`control plane GET ${path} failed: ${reason}`)
  }
  if (!response.ok) {
    throw new ControlPlaneError(`control plane GET ${path} answered ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new ControlPlaneError(`control plane GET ${path} did not answer JSON`)
  }
}

/** Parses with `schema`, naming the path and the fields at fault but never a value. */
function parse<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')
  throw new ControlPlaneError(`control plane GET ${path} is invalid at ${fields.join(', ')}`)
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
      if (uuid) {
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
        status: STATUS[project.status] ?? 'UNKNOWN',
        insertedAt: project.created_at,
        env,
      }
    })
  )
}
