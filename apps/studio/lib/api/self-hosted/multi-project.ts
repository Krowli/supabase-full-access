import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import {
  currentProjectName,
  currentProjectRef,
  DEFAULT_PROJECT_REF,
  projectEnv,
  projectJwtSecret,
  projectPostgres,
} from './project-context'

/**
 * The multi-project branch of upstream readers that take their values from module-level constants
 * or a process-wide singleton, neither of which can follow a request to another project. Each is
 * called from a one-line `if (isMultiProject())` in the upstream file, so a single-project Studio
 * never reaches this module.
 */

/** `util.ts`'s `getConnectionString`, for this request's project. */
export function projectConnectionString({ readOnly }: { readOnly: boolean }): string {
  const { host, port, database, password, userReadWrite, userReadOnly } = projectPostgres()
  const user = readOnly ? userReadOnly : userReadWrite
  return `postgresql://${user}:${password}@${host}:${port}/${database}`
}

/** One admin client per project, keyed by what it was built from so a changed key builds a new one. */
const adminClients = new Map<string, SupabaseClient>()

/** `self-hosted-admin.ts`'s client, for this request's project. */
export function projectAdminClient(): SupabaseClient {
  const url = projectEnv('SUPABASE_URL')!
  const serviceKey = projectEnv('SUPABASE_SERVICE_KEY')!
  const cacheKey = `${url}\n${serviceKey}`

  let client = adminClients.get(cacheKey)
  if (!client) {
    client = createClient(url, serviceKey)
    adminClients.set(cacheKey, client)
  }
  return client
}

/** The registry's name for the project, else the single-project name for `default` and the ref for any other. */
const projectName = (ref: string, singleProjectName: string) =>
  currentProjectName() ?? (ref === DEFAULT_PROJECT_REF ? singleProjectName : ref)

/** The fields of `settings.ts`'s response that name the project. */
type ProjectSettingsFields = {
  app_config: { endpoint: string; storage_endpoint: string; protocol?: string }
  db_host: string
  db_port: number
  jwt_secret?: string
  name: string
  ref: string
  service_api_keys: { api_key: string; tags: string }[]
}

/**
 * Rewrites `settings.ts`'s `getProjectSettings` response, which is built fresh on every call, for
 * this request's project. The endpoint fields are parsed the way `lib/constants/api.ts` parses
 * `SUPABASE_PUBLIC_URL` for the single project.
 */
export function applyProjectSettings(settings: ProjectSettingsFields): void {
  const publicUrl = new URL(projectEnv('SUPABASE_PUBLIC_URL') || 'http://localhost:8000')
  const ref = currentProjectRef()

  settings.app_config.endpoint = publicUrl.host
  settings.app_config.storage_endpoint = publicUrl.host
  settings.app_config.protocol = publicUrl.protocol.replace(':', '')
  settings.db_host = publicUrl.hostname
  settings.db_port = projectPostgres().port
  settings.jwt_secret = projectJwtSecret()
  settings.name = projectName(ref, settings.name)
  settings.ref = ref
  for (const key of settings.service_api_keys) {
    key.api_key =
      projectEnv(key.tags === 'anon' ? 'SUPABASE_ANON_KEY' : 'SUPABASE_SERVICE_KEY') ?? ''
  }
}

/**
 * Rewrites `pages/api/platform/projects/[ref]/index.ts`'s project detail for this request's
 * project. The dashboard reads the ref for every later call from this response rather than from
 * the URL, so a detail that always says `default` would send project B's pages to project A.
 */
export function applyProjectDetail(detail: { ref: string; name: string; restUrl: string }): void {
  const publicUrl = new URL(projectEnv('SUPABASE_PUBLIC_URL') || 'http://localhost:8000')
  const ref = currentProjectRef()

  detail.ref = ref
  detail.name = projectName(ref, detail.name)
  detail.restUrl = `${publicUrl.origin}/rest/v1/`
}
