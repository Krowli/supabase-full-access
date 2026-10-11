import { resolve } from 'node:path'

import type { CoolifyConfig } from './coolify.ts'
import { parseSecretsKey } from './secrets.ts'
import type { StorageTarget } from './template.ts'

export type Config = {
  port: number
  coolify: CoolifyConfig
  registryDatabaseUrl: string
  secretsKey: Buffer
  apiToken: string
  domainSuffix: string
  storage: StorageTarget
  templatePath: string
  healthTimeoutMs: number
  pollIntervalMs: number
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
  const registryDatabaseUrl = req('REGISTRY_DATABASE_URL')
  const rawKey = req('PLATFORM_SECRETS_KEY')
  const apiToken = req('CONTROL_PLANE_TOKEN')
  const domainSuffix = req('PROJECT_DOMAIN_SUFFIX')

  // The target is the shared MinIO. `file` is for testing until MinIO is shared (M5).
  const backend = env.PROJECT_STORAGE_BACKEND ?? 's3'
  let storage: StorageTarget
  if (backend === 'file') {
    storage = { backend: 'file' }
  } else if (backend === 's3') {
    storage = {
      backend: 's3',
      endpoint: req('PROJECT_S3_ENDPOINT'),
      region: env.PROJECT_S3_REGION ?? 'us-east-1',
      accessKey: req('PROJECT_S3_ACCESS_KEY'),
      secretKey: req('PROJECT_S3_SECRET_KEY'),
    }
  } else {
    throw new Error(`PROJECT_STORAGE_BACKEND must be s3 or file, got ${backend}`)
  }

  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`)

  return {
    port: Number(env.PORT ?? 8080),
    coolify,
    registryDatabaseUrl,
    secretsKey: parseSecretsKey(rawKey),
    apiToken,
    domainSuffix,
    storage,
    templatePath:
      env.PROJECT_TEMPLATE_PATH ??
      resolve(import.meta.dirname, '../../../deploy/platform/project-compose.yaml'),
    healthTimeoutMs: Number(env.PROVISION_TIMEOUT_SECONDS ?? 600) * 1000,
    pollIntervalMs: 5000,
  }
}
