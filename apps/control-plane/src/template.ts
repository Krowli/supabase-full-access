import { readFileSync } from 'node:fs'

import type { ProjectSecrets } from './secrets.ts'

export type StorageTarget =
  | { backend: 's3'; endpoint: string; region: string; accessKey: string; secretKey: string }
  | { backend: 'file' }

export type TemplateValues = {
  REF: string
  PUBLIC_URL: string
  STORAGE_BACKEND: string
  S3_BUCKET: string
  S3_ENDPOINT: string
  S3_REGION: string
}

// Values land in list-style compose lines (`- KEY=value`), so only characters that cannot
// break YAML or start an interpolation are allowed.
const SAFE_VALUE = /^[A-Za-z0-9._:/-]*$/

export function loadTemplate(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Replaces every {{NAME}}. Unknown names and unsafe values are errors, not silent blanks. */
export function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(values, name))
      throw new Error(`Template placeholder {{${name}}} has no value`)
    const value = values[name as keyof TemplateValues]
    if (!SAFE_VALUE.test(value))
      throw new Error(`Template value for {{${name}}} has unsafe characters`)
    return value
  })
}

export function templateValues(
  ref: string,
  domainSuffix: string,
  storage: StorageTarget
): TemplateValues {
  return {
    REF: ref,
    PUBLIC_URL: `https://${ref}.${domainSuffix}`,
    STORAGE_BACKEND: storage.backend,
    S3_BUCKET: ref,
    S3_ENDPOINT: storage.backend === 's3' ? storage.endpoint : '',
    S3_REGION: storage.backend === 's3' ? storage.region : '',
  }
}

/** The Coolify env vars the template reads as ${NAME}. Secrets go here, never into the compose. */
export function serviceEnvs(
  secrets: ProjectSecrets,
  storage: StorageTarget
): Record<string, string> {
  return {
    PROJECT_DB_PASSWORD: secrets.db_password,
    PROJECT_JWT_SECRET: secrets.jwt_secret,
    PROJECT_ANON_KEY: secrets.anon_key,
    PROJECT_SERVICE_KEY: secrets.service_key,
    S3_ACCESS_KEY: storage.backend === 's3' ? storage.accessKey : '',
    S3_SECRET_KEY: storage.backend === 's3' ? storage.secretKey : '',
  }
}
