import { resolve } from 'node:path'

import type { CoolifyConfig } from './coolify.ts'
import { parseSecretsKey } from './secrets.ts'
import type { SharedEndpoints } from './template.ts'

export type Config = {
  port: number
  coolify: CoolifyConfig
  registryDatabaseUrl: string
  secretsKey: Buffer
  apiToken: string
  domainSuffix: string
  /** Shared services as project stacks reach them (rendered into each project compose). */
  projectShared: SharedEndpoints
  /** Shared services as the control plane reaches them (same Coolify service network). */
  kong: { adminUrl: string; adminToken: string }
  supavisorUrl: string
  realtimeUrl: string
  adminJwtSecret: string
  minio: { url: string; rootUser: string; rootPassword: string }
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

  const coolify: CoolifyConfig = {
    url: req('COOLIFY_URL'),
    token: req('COOLIFY_TOKEN'),
    projectUuid: req('COOLIFY_PROJECT_UUID'),
    environment: req('COOLIFY_ENVIRONMENT'),
    serverUuid: req('COOLIFY_SERVER_UUID'),
  }
  const config = {
    port: Number(env.PORT ?? 8080),
    coolify,
    registryDatabaseUrl: req('REGISTRY_DATABASE_URL'),
    rawKey: req('PLATFORM_SECRETS_KEY'),
    apiToken: req('CONTROL_PLANE_TOKEN'),
    domainSuffix: req('PROJECT_DOMAIN_SUFFIX'),
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
