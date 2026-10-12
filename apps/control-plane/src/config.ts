import { resolve } from 'node:path'

import type { CoolifyTargetConfig } from './coolify.ts'
import type { DashboardOptions } from './kong.ts'
import { parseSecretsKey } from './secrets.ts'
import type { SharedEndpoints } from './template.ts'

export type Config = {
  port: number
  coolify: CoolifyTargetConfig
  registryDatabaseUrl: string
  secretsKey: Buffer
  apiToken: string
  domainSuffix: string
  /**
   * Where each project's settings files live on the host (src/project-dirs.ts). The platform
   * compose binds it into this container at the same path.
   */
  projectsHostDir: string
  /** Shared services as project stacks reach them (rendered into each project compose). */
  projectShared: SharedEndpoints
  /** Shared services as the control plane reaches them (same Coolify service network). */
  kong: { adminUrl: string; adminToken: string }
  supavisorUrl: string
  realtimeUrl: string
  adminJwtSecret: string
  minio: { url: string; rootUser: string; rootPassword: string }
  /** Studio, routed by Kong at studio.<suffix> with basic auth, when DASHBOARD_URL is set. */
  dashboard?: DashboardOptions
  templatePath: string
  healthTimeoutMs: number
  pollIntervalMs: number
  kongReconcileMs: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = []
  const req = (name: string) => {
    const value = env[name]
    if (!value) missing.push(name)
    return value ?? ''
  }

  // Project and server: explicit, or taken from the platform's own Coolify application
  // (resolveCoolifyTarget in src/coolify.ts).
  const coolify: CoolifyTargetConfig = {
    url: req('COOLIFY_URL'),
    token: req('COOLIFY_TOKEN'),
    projectUuid: env.COOLIFY_PROJECT_UUID || undefined,
    serverUuid: env.COOLIFY_SERVER_UUID || undefined,
    resourceUuid: env.COOLIFY_RESOURCE_UUID || undefined,
    environment: env.COOLIFY_ENVIRONMENT || 'projects',
  }
  const config = {
    port: Number(env.PORT ?? 8080),
    coolify,
    registryDatabaseUrl: req('REGISTRY_DATABASE_URL'),
    rawKey: req('PLATFORM_SECRETS_KEY'),
    apiToken: req('CONTROL_PLANE_TOKEN'),
    domainSuffix: req('PROJECT_DOMAIN_SUFFIX'),
    projectsHostDir: req('PROJECTS_HOST_DIR'),
    projectShared: {
      s3Endpoint: req('PROJECT_S3_ENDPOINT'),
      s3Region: env.PROJECT_S3_REGION ?? 'us-east-1',
      imgproxyUrl: req('PROJECT_IMGPROXY_URL'),
    },
    kong: {
      adminUrl: env.KONG_ADMIN_URL ?? 'http://kong:8001',
      adminToken: req('KONG_ADMIN_TOKEN'),
    },
    supavisorUrl: env.SUPAVISOR_URL ?? 'http://supavisor:4000',
    realtimeUrl: env.REALTIME_URL ?? 'http://realtime:4000',
    adminJwtSecret: req('PLATFORM_ADMIN_JWT_SECRET'),
    minio: {
      url: env.MINIO_URL ?? 'http://minio:9000',
      rootUser: req('MINIO_ROOT_USER'),
      rootPassword: req('MINIO_ROOT_PASSWORD'),
    },
    dashboard: env.DASHBOARD_URL
      ? {
          url: env.DASHBOARD_URL,
          username: req('DASHBOARD_USERNAME'),
          password: req('DASHBOARD_PASSWORD'),
        }
      : undefined,
  }
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`)

  const { rawKey, ...rest } = config
  return {
    ...rest,
    secretsKey: parseSecretsKey(rawKey),
    templatePath:
      env.PROJECT_TEMPLATE_PATH ??
      resolve(import.meta.dirname, '../../../deploy/platform/project-compose.yaml'),
    healthTimeoutMs: Number(env.PROVISION_TIMEOUT_SECONDS ?? 600) * 1000,
    pollIntervalMs: 5000,
    kongReconcileMs: 15_000,
  }
}
