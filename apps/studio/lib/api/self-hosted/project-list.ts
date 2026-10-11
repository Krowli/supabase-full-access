import type { NextApiRequest } from 'next'

import { DEFAULT_PROJECT_REF, listProjects, type ResolvedProject } from './project-context'
import { DEFAULT_PROJECT } from '@/lib/constants/api'

/**
 * The project lists the dashboard's switcher reads, built from the registry
 * (deploy/platform/SPEC.md §2.1). Self-hosted there is one organization, `default-org-slug`, and
 * every project belongs to it. Without a registry the only project is `default`, exactly as
 * `DEFAULT_PROJECT` describes it.
 */

export const DEFAULT_ORG_SLUG = 'default-org-slug'

const DEFAULT_LIMIT = 100

/** A project in the shape of `DEFAULT_PROJECT`, which every self-hosted project route starts from. */
export type PlatformProject = typeof DEFAULT_PROJECT

/** `default` keeps id 1; the rest are numbered in registry order. Nothing self-hosted keys on them. */
function toPlatformProject(project: ResolvedProject, index: number): PlatformProject {
  const isDefault = project.ref === DEFAULT_PROJECT_REF
  return {
    ...DEFAULT_PROJECT,
    id: index + 1,
    ref: project.ref,
    name: project.name ?? (isDefault ? DEFAULT_PROJECT.name : project.ref),
    status: project.status,
    inserted_at: project.insertedAt ?? DEFAULT_PROJECT.inserted_at,
  }
}

/** Every project, `default` first. */
export async function platformProjects(): Promise<PlatformProject[]> {
  return (await listProjects()).map(toPlatformProject)
}

const queryString = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value

const queryNumber = (value: string | string[] | undefined, fallback: number) => {
  const parsed = Number.parseInt(queryString(value) ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const SORTS: Record<string, (a: PlatformProject, b: PlatformProject) => number> = {
  name_asc: (a, b) => a.name.localeCompare(b.name),
  name_desc: (a, b) => b.name.localeCompare(a.name),
  created_asc: (a, b) => a.inserted_at.localeCompare(b.inserted_at),
  created_desc: (a, b) => b.inserted_at.localeCompare(a.inserted_at),
}

/**
 * The page the query asks for: `search` (name or ref, any case), `statuses` (comma-separated),
 * `sort` (`name_asc` unless given), `limit` and `offset`.
 */
export async function paginatedProjects(query: NextApiRequest['query']) {
  const search = queryString(query.search)?.toLowerCase()
  const statuses = queryString(query.statuses)?.split(',').filter(Boolean)
  const sort = SORTS[queryString(query.sort) ?? ''] ?? SORTS.name_asc
  const limit = queryNumber(query.limit, DEFAULT_LIMIT)
  const offset = queryNumber(query.offset, 0)

  const matching = (await platformProjects())
    .filter(
      (project) =>
        !search ||
        project.name.toLowerCase().includes(search) ||
        project.ref.toLowerCase().includes(search)
    )
    .filter((project) => !statuses?.length || statuses.includes(project.status))
    .sort(sort)

  return {
    pagination: { count: matching.length, limit, offset },
    projects: matching.slice(offset, offset + limit),
  }
}

/** A page of `GET /platform/projects` with `Version: 2` (`ListProjectsPaginatedResponse`). */
export async function listProjectsResponse(query: NextApiRequest['query']) {
  const { pagination, projects } = await paginatedProjects(query)
  return {
    pagination,
    projects: projects.map((project) => ({
      ...project,
      organization_slug: DEFAULT_ORG_SLUG,
      is_branch_enabled: false,
      is_physical_backups_enabled: null,
      preview_branch_refs: [],
      subscription_id: null,
    })),
  }
}

/** A page of `GET /platform/organizations/{slug}/projects` (`OrganizationProjectsResponse`). */
export async function organizationProjectsResponse(query: NextApiRequest['query']) {
  const { pagination, projects } = await paginatedProjects(query)
  return {
    pagination,
    projects: projects.map((project) => ({
      cloud_provider: project.cloud_provider,
      databases: [
        {
          cloud_provider: project.cloud_provider,
          identifier: project.ref,
          region: project.region,
          status: project.status,
          type: 'PRIMARY',
        },
      ],
      inserted_at: project.inserted_at,
      integration_source: null,
      is_branch: false,
      name: project.name,
      ref: project.ref,
      region: project.region,
      status: project.status,
    })),
  }
}

/** The projects of the profile's one organization. */
export async function profileProjects() {
  return (await platformProjects()).map((project) => ({ ...project, connectionString: '' }))
}
