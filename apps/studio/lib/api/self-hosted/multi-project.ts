import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto-js'

import { ENCRYPTION_KEY } from './constants'
import {
  currentProjectInsertedAt,
  currentProjectName,
  currentProjectRef,
  currentProjectStatus,
  DEFAULT_PROJECT_REF,
  hasDefaultStack,
  isMultiProject,
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

/**
 * The URLs and host a project route reports, from this project's `SUPABASE_PUBLIC_URL`, parsed the
 * way `lib/constants/api.ts` parses it for the single project.
 */
function publicEndpoint() {
  const url = new URL(projectEnv('SUPABASE_PUBLIC_URL') || 'http://localhost:8000')
  return {
    restUrl: `${url.origin}/rest/v1/`,
    endpoint: url.host,
    protocol: url.protocol.replace(':', ''),
    dbHost: url.hostname,
  }
}

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
  const { endpoint, protocol, dbHost } = publicEndpoint()
  const ref = currentProjectRef()

  settings.app_config.endpoint = endpoint
  settings.app_config.storage_endpoint = endpoint
  settings.app_config.protocol = protocol
  settings.db_host = dbHost
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
export function applyProjectDetail(detail: {
  ref: string
  name: string
  status: string
  inserted_at: string
  restUrl: string
}): void {
  const ref = currentProjectRef()

  detail.ref = ref
  detail.name = projectName(ref, detail.name)
  // The building screen shows while this is `COMING_UP` and polls `/status` until it is running.
  detail.status = currentProjectStatus()
  detail.inserted_at = currentProjectInsertedAt() ?? detail.inserted_at
  // `default` without a stack has no endpoint; the dashboard only reads its status and moves on.
  const isStacklessDefault = ref === DEFAULT_PROJECT_REF && !hasDefaultStack()
  detail.restUrl = isStacklessDefault ? '' : publicEndpoint().restUrl
}

/**
 * Rewrites `pages/api/platform/projects/[ref]/databases.ts`'s one database for this request's
 * project. The Connect sheet picks the primary database as the one whose `identifier` is the ref.
 */
export function applyProjectDatabase(database: {
  identifier: string
  db_host: string
  db_port: number
  restUrl: string
}): void {
  const { restUrl, dbHost } = publicEndpoint()

  database.identifier = currentProjectRef()
  database.db_host = dbHost
  database.db_port = projectPostgres().port
  database.restUrl = restUrl
}

type ProjectPropsService = { app_config: { endpoint: string } }

/** Rewrites `pages/api/platform/props/project/[ref]/api.ts`'s legacy props for this request's project. */
export function applyProjectProps(props: {
  project: {
    ref: string
    name: string
    db_host: string
    db_port: number
    services: ProjectPropsService[]
  }
  autoApiService: ProjectPropsService & {
    project: { ref: string }
    protocol: string
    endpoint: string
    restUrl: string
  }
}): void {
  const { restUrl, endpoint, protocol, dbHost } = publicEndpoint()
  const ref = currentProjectRef()
  const { project, autoApiService } = props

  project.ref = ref
  project.name = projectName(ref, project.name)
  project.db_host = dbHost
  project.db_port = projectPostgres().port
  for (const service of project.services) service.app_config.endpoint = endpoint

  autoApiService.project.ref = ref
  autoApiService.app_config.endpoint = endpoint
  autoApiService.protocol = protocol
  autoApiService.endpoint = endpoint
  autoApiService.restUrl = restUrl
}

/**
 * The headers a `pg-meta/[ref]` GET route forwards, plus this project's encrypted connection string.
 * Without one, pg-meta answers from its own `PG_META_DB_*` database, which is `default`'s. Single
 * project, the headers pass through untouched, as before.
 */
export function withProjectConnection<T extends object>(headers: T): T {
  if (!isMultiProject()) return headers
  const connection = projectConnectionString({ readOnly: false })
  return {
    ...headers,
    'x-connection-encrypted': crypto.AES.encrypt(connection, ENCRYPTION_KEY).toString(),
  }
}
