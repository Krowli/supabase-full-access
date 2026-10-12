import { readFileSync } from 'node:fs'

import type { ProjectSecrets } from './secrets.ts'

/** Shared services as the project stacks reach them on the `coolify` network. */
export type SharedEndpoints = {
  /** The shared MinIO, e.g. http://minio-<platform-uuid>:9000. Each project gets bucket <ref>. */
  s3Endpoint: string
  s3Region: string
  /** The shared imgproxy, e.g. http://imgproxy-<platform-uuid>:8080. */
  imgproxyUrl: string
}

export type TemplateValues = {
  REF: string
  PUBLIC_URL: string
  S3_BUCKET: string
  S3_ENDPOINT: string
  S3_REGION: string
  IMGPROXY_URL: string
  /** The host directory with each project's settings files (src/project-dirs.ts). */
  PROJECTS_HOST_DIR: string
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
  shared: SharedEndpoints,
  projectsHostDir: string
): TemplateValues {
  return {
    REF: ref,
    PUBLIC_URL: `https://${ref}.${domainSuffix}`,
    S3_BUCKET: ref,
    S3_ENDPOINT: shared.s3Endpoint,
    S3_REGION: shared.s3Region,
    IMGPROXY_URL: shared.imgproxyUrl,
    PROJECTS_HOST_DIR: projectsHostDir,
  }
}

/** The Coolify env vars the template reads as ${NAME}. Secrets go here, never into the compose. */
export function serviceEnvs(secrets: ProjectSecrets): Record<string, string> {
  return {
    PROJECT_DB_PASSWORD: secrets.db_password,
    PROJECT_JWT_SECRET: secrets.jwt_secret,
    PROJECT_ANON_KEY: secrets.anon_key,
    PROJECT_SERVICE_KEY: secrets.service_key,
    S3_ACCESS_KEY: secrets.s3_access_key,
    S3_SECRET_KEY: secrets.s3_secret_key,
  }
}
