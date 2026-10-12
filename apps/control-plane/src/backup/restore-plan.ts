// The parts of a restore into a new project that depend on what pg_dump wrote. Learned by
// restoring a dump of a project stack into a fresh one (deploy/platform/SPEC.md §19):
// - the roles dump also sets the passwords of the roles the new project runs on, which would lock
//   its services out, so only the roles it lacks are kept;
// - `pg_restore --clean` drops and recreates pg_graphql, after which graphql_public.graphql and its
//   grants are gone, so everything about GraphQL is left as the fresh project made it;
// - a few errors are expected: pg_dump 17 sets transaction_timeout, unknown to Postgres 15, and
//   `--clean` cannot drop the schemas the fresh project's extensions live in.

/** A role name as pg_dumpall writes it, quoted or not. */
const ROLE = String.raw`("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`

const unquote = (name: string) => (name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name)

export function filterRoles(rolesSql: string, existingRoles: Set<string>): string {
  const isNew = (name: string) => !existingRoles.has(unquote(name))
  const role = new RegExp(String.raw`^(?:CREATE ROLE|ALTER ROLE|COMMENT ON ROLE) ${ROLE}[ ;]`)
  const grant = new RegExp(String.raw`^GRANT ${ROLE} TO ${ROLE}[ ;]`)
  const kept: string[] = []
  for (const line of rolesSql.split('\n')) {
    const r = role.exec(line)
    if (r) {
      if (isNew(r[1])) kept.push(line)
      continue
    }
    const g = grant.exec(line)
    if (g && (isNew(g[1]) || isNew(g[2]))) kept.push(line)
  }
  return kept.length ? `${kept.join('\n')}\n` : ''
}

/** `pg_restore -l` output without the entries a fresh project owns: everything about GraphQL. */
export function filterToc(toc: string): string {
  return toc
    .split('\n')
    .filter((line) => line.startsWith(';') || !/^\d+;.*(SCHEMA - graphql|EXTENSION - pg_graphql|graphql_public|pg_graphql|graphql_placeholder)/.test(line))
    .join('\n')
}

const BENIGN = [
  /unrecognized configuration parameter "transaction_timeout"/,
  /schema "[^"]+" already exists/,
  /cannot drop schema \S+ because other objects depend on it/,
]

export function benignRestoreError(message: string): boolean {
  return BENIGN.some((re) => re.test(message))
}

/** The old project's public host in its settings files becomes the new project's. */
export function rewriteProjectRef(text: string, oldRef: string, newRef: string, domainSuffix: string): string {
  return text.split(`${oldRef}.${domainSuffix}`).join(`${newRef}.${domainSuffix}`)
}
