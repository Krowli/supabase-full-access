import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PROJECT_ENV_NAMES } from './project-context'

/**
 * Guard for the multi-project resolver (deploy/platform/SPEC.md §6, risk 4).
 *
 * Every value that names a project's backend has to come from `project-context.ts`, or a request
 * for one project silently reaches another. Upstream adds env reads all the time, and a new
 * `process.env.SUPABASE_URL` in a route compiles, passes its own tests, and talks to `default`.
 * So this test pins every place under `lib/api` and `pages/api` that still reads one of these
 * names, or imports a constant built from one, outside the resolver. A new one fails here, and
 * whoever merges it decides: route it through `projectEnv`, or add it below with the reason.
 */

const STUDIO = resolve(__dirname, '../../..')
const SCANNED = ['lib/api', 'pages/api']
const RESOLVER = 'lib/api/self-hosted/project-context.ts'

/** A direct read of any name the resolver answers per project, plus the SPEC's `SUPABASE_`/`POSTGRES_` families. */
const PROJECT_ENV_READ = new RegExp(
  `process\\.env(?:\\.|\\[\\s*['"])((?:SUPABASE_|POSTGRES_|AUTH_JWT|GOTRUE_)[A-Z0-9_]*|${PROJECT_ENV_NAMES.join('|')})\\b`,
  'g'
)

/** Constants computed once, at import, from the single project's environment. */
const SNAPSHOT_MODULES: Record<string, RegExp> = {
  'lib/api/self-hosted/constants.ts':
    /^(POSTGRES_(HOST|PORT|DATABASE|PASSWORD|USER_READ_WRITE|USER_READ_ONLY)|AUTH_JWT_SECRET|DEFAULT_EXPOSED_SCHEMAS)$/,
  'lib/constants/api.ts': /^PROJECT_(REST_URL|ENDPOINT|ENDPOINT_PROTOCOL|DB_HOST)$/,
}

/**
 * Single-project code that an `if (isMultiProject())` branch steps around. Each must keep its
 * branch: the test fails if a merge drops it.
 */
const GATED = [
  'pages/api/mcp/index.ts',
  'pages/api/platform/profile/index.ts',
  'pages/api/platform/projects/index.ts',
  'pages/api/platform/projects/[ref]/databases.ts',
  'pages/api/platform/projects/[ref]/index.ts',
  'pages/api/platform/props/project/[ref]/api.ts',
  'lib/api/self-hosted-admin.ts',
  'lib/api/self-hosted/service-config/postgrest.ts',
  'lib/api/self-hosted/settings.ts',
  'lib/api/self-hosted/util.ts',
]

/** Direct reads that remain, by file. Sorted, with repeats, so a second read of a name is new too. */
const KNOWN_READS: Record<string, string[]> = {
  // The single project's snapshot. Only the gated files below import from it.
  'lib/api/self-hosted/constants.ts': [
    'AUTH_JWT_SECRET',
    'PGRST_DB_SCHEMAS',
    'POSTGRES_DB',
    'POSTGRES_HOST',
    'POSTGRES_PASSWORD',
    'POSTGRES_PORT',
    'POSTGRES_USER_READ_ONLY',
    'POSTGRES_USER_READ_WRITE',
  ],
  'lib/api/self-hosted-admin.ts': ['SUPABASE_SERVICE_KEY', 'SUPABASE_URL'],
  'lib/api/self-hosted/settings.ts': ['SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_KEY'],
  // The MCP route takes no ref and serves `default`; `pages/api/mcp` refuses to run with a registry.
  'lib/api/self-hosted/mcp.ts': ['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_PUBLISHABLE_KEY'],
  // Later: the CLI's S3 keys, read at import; nothing in the dashboard calls this route.
  'pages/api/get-s3-keys.ts': ['S3_PROTOCOL_ACCESS_KEY_ID', 'S3_PROTOCOL_ACCESS_KEY_SECRET'],
  // Out of scope: one edge runtime serves `default` only (SPEC.md §5).
  'pages/api/edge-functions/test.ts': ['SUPABASE_PUBLIC_URL', 'SUPABASE_URL'],
}

/** Imports of the snapshot constants that remain, by file. */
const KNOWN_SNAPSHOT_IMPORTS: Record<string, string[]> = {
  'lib/api/self-hosted/service-config/postgrest.ts': [
    'DEFAULT_EXPOSED_SCHEMAS',
    'POSTGRES_DATABASE',
  ],
  'lib/api/self-hosted/settings.ts': [
    'AUTH_JWT_SECRET',
    'POSTGRES_PORT',
    'PROJECT_DB_HOST',
    'PROJECT_ENDPOINT',
    'PROJECT_ENDPOINT_PROTOCOL',
  ],
  'lib/api/self-hosted/util.ts': [
    'POSTGRES_DATABASE',
    'POSTGRES_HOST',
    'POSTGRES_PASSWORD',
    'POSTGRES_PORT',
    'POSTGRES_USER_READ_ONLY',
    'POSTGRES_USER_READ_WRITE',
  ],
  'pages/api/platform/projects/[ref]/index.ts': ['PROJECT_REST_URL'],
  // The single-project answers of the databases and props routes; both are gated below.
  'pages/api/platform/projects/[ref]/databases.ts': [
    'POSTGRES_PORT',
    'PROJECT_DB_HOST',
    'PROJECT_REST_URL',
  ],
  'pages/api/platform/props/project/[ref]/api.ts': [
    'POSTGRES_PORT',
    'PROJECT_DB_HOST',
    'PROJECT_ENDPOINT',
    'PROJECT_ENDPOINT_PROTOCOL',
    'PROJECT_REST_URL',
  ],
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(STUDIO, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    const isSource = /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
    return isSource ? [path] : []
  })
}

const files = SCANNED.flatMap(sourceFiles).filter((file) => file !== RESOLVER)
const read = (file: string) => readFileSync(join(STUDIO, file), 'utf8')

/** The module an import specifier names, relative to the studio root and with its extension. */
function importTarget(file: string, specifier: string): string | undefined {
  let path: string
  if (specifier.startsWith('@/')) path = join(STUDIO, specifier.slice(2))
  else if (specifier.startsWith('.')) path = resolve(STUDIO, dirname(file), specifier)
  else return undefined
  const target = relative(STUDIO, path)
  return [`${target}.ts`, join(target, 'index.ts')].find(
    (candidate) => candidate in SNAPSHOT_MODULES
  )
}

function snapshotImports(file: string): string[] {
  const names: string[] = []
  for (const [, specifiers, from] of read(file).matchAll(
    /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g
  )) {
    const target = importTarget(file, from)
    if (!target) continue
    for (const specifier of specifiers.split(',')) {
      const name = specifier.trim().split(/\s+as\s+/)[0]
      if (SNAPSHOT_MODULES[target].test(name)) names.push(name)
    }
  }
  return names.sort()
}

const collect = (pick: (file: string) => string[]) =>
  Object.fromEntries(
    files.map((file) => [file, pick(file)] as const).filter(([, names]) => names.length > 0)
  )

describe('project env guard', () => {
  it('scans the API code', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain('lib/api/self-hosted/util.ts')
  })

  it('reads per-project env only through the resolver, apart from the pinned files', () => {
    const reads = collect((file) =>
      [...read(file).matchAll(PROJECT_ENV_READ)].map(([, name]) => name).sort()
    )
    expect(reads).toEqual(KNOWN_READS)
  })

  it('imports the single-project constants only where pinned', () => {
    expect(collect(snapshotImports)).toEqual(KNOWN_SNAPSHOT_IMPORTS)
  })

  it.each(GATED)('%s keeps its multi-project branch', (file) => {
    expect(read(file)).toMatch(/if \(isMultiProject\(\)\)|isMultiProject\(\) \?/)
  })

  // Without the header pg-meta opens its own default database, which is `default`'s. (The `query`
  // route goes through `executeQuery`, which always sends one.)
  it('sends the project connection from every pg-meta GET route', () => {
    const proxies = files.filter(
      (file) =>
        file.startsWith('pages/api/platform/pg-meta/[ref]/') && read(file).includes('fetchGet(')
    )
    const unwrapped = proxies.filter(
      (file) => !read(file).includes('constructHeaders(withProjectConnection(req.headers))')
    )

    expect(proxies).toHaveLength(10)
    expect(unwrapped).toEqual([])
  })
})
