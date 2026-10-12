import type { NextApiRequest, NextApiResponse } from 'next'

import {
  ControlPlaneError,
  createControlPlaneProject,
  deleteControlPlaneProject,
  platformStatus,
  retryControlPlaneProject,
  type ControlPlaneConfig,
} from './control-plane-registry'
import {
  controlPlaneConfig,
  currentProjectName,
  currentProjectRef,
  DEFAULT_PROJECT_REF,
  invalidateProjectRegistry,
} from './project-context'
import { DEFAULT_ORG_SLUG } from './project-list'

/**
 * Creating, retrying and deleting a project on a multi-project Studio (deploy/platform/SPEC.md M6).
 * Each is one call to the control plane (`control-plane-registry.ts`), after which the cached
 * registry is dropped so the next request sees the change. Only the control plane can do these: a
 * registry file is edited by hand, and `default` is the Studio's own stack, which it never owns.
 *
 * Errors are `{ message }`, the platform API's shape, which is what the dashboard's fetch client
 * reads a message from (`data/fetchers.ts`, `handleError`); the `{ error: { message } }` of other
 * self-hosted routes reaches the user as an unspecified error. The control plane's refusals of the
 * request (400, 404, 409) keep their status and message; anything else about the control plane is
 * a 502 naming the call.
 */

const NO_CONTROL_PLANE =
  'Studio can create, retry and delete projects only with the control plane as its registry (STUDIO_PROJECT_REGISTRY_URL)'

const fail = (res: NextApiResponse, status: number, message: string): void =>
  res.status(status).json({ message })

async function withControlPlane(
  res: NextApiResponse,
  fn: (config: ControlPlaneConfig) => Promise<void>
): Promise<void> {
  const config = controlPlaneConfig()
  if (!config) return fail(res, 501, NO_CONTROL_PLANE)
  try {
    return await fn(config)
  } catch (error) {
    if (error instanceof ControlPlaneError) return fail(res, error.status, error.message)
    throw error
  }
}

/** `POST /platform/projects`. Only `name` is used: the control plane picks the ref and generates every secret, the database password included. */
export function handleCreateProject(req: NextApiRequest, res: NextApiResponse) {
  return withControlPlane(res, async (config) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!name || name.length > 64) return fail(res, 400, 'name is required (1-64 chars)')

    const project = await createControlPlaneProject(config, name)
    invalidateProjectRegistry()

    // `CreateProjectResponse`. The dashboard reads only `ref`, to open the new project. It has no
    // numeric id or keys yet: the list numbers projects itself, and the keys are read per request.
    return res.status(201).json({
      id: 0,
      ref: project.ref,
      name: project.name,
      status: platformStatus(project.status),
      organization_id: 1,
      organization_slug: DEFAULT_ORG_SLUG,
      cloud_provider: 'localhost',
      region: 'local',
      endpoint: project.endpoint,
      anon_key: '',
      service_key: '',
      inserted_at: project.created_at ?? null,
      is_branch_enabled: false,
      is_physical_backups_enabled: null,
      preview_branch_refs: [],
      subscription_id: null,
    })
  })
}

/** `POST /platform/projects/{ref}/retry`, run as the project (`apiWrapper` has answered 404 for an unknown ref). */
export function handleRetryProject(_req: NextApiRequest, res: NextApiResponse) {
  return withControlPlane(res, async (config) => {
    const ref = currentProjectRef()
    if (ref === DEFAULT_PROJECT_REF) return fail(res, 400, 'Project default is not provisioned')

    const project = await retryControlPlaneProject(config, ref)
    invalidateProjectRegistry()

    // The control plane re-runs provisioning of any project that is not running, and its answer
    // can still carry the old status, so a retried project is reported as coming up.
    const status = project.status === 'ACTIVE_HEALTHY' ? 'ACTIVE_HEALTHY' : 'COMING_UP'
    return res.status(202).json({ ref, status })
  })
}

/** `DELETE /platform/projects/{ref}`, run as the project. Answers `RemoveProjectResponse`. */
export function handleDeleteProject(_req: NextApiRequest, res: NextApiResponse) {
  return withControlPlane(res, async (config) => {
    const ref = currentProjectRef()
    if (ref === DEFAULT_PROJECT_REF) return fail(res, 400, 'Project default cannot be deleted')

    const name = currentProjectName() ?? ref
    await deleteControlPlaneProject(config, ref)
    invalidateProjectRegistry()
    return res.status(200).json({ id: 0, ref, name })
  })
}
