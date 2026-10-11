import pg from 'pg'

import { decrypt, encrypt, SECRET_COLUMNS, type ProjectSecrets } from './secrets.ts'

export const STATUSES = ['CREATING', 'COMING_UP', 'ACTIVE_HEALTHY', 'FAILED', 'DELETING'] as const
export type ProjectStatus = (typeof STATUSES)[number]

export type Project = {
  ref: string
  name: string
  status: ProjectStatus
  coolify_service_uuid: string | null
  /** The provisioning or delete step that ran last; with FAILED, the one that failed. */
  step: string | null
  created_at: Date
  updated_at: Date
  last_error: string | null
}

export type ProjectUpdate = Partial<
  Pick<Project, 'status' | 'coolify_service_uuid' | 'step' | 'last_error'>
>

export interface Registry {
  insert(project: { ref: string; name: string }, secrets: ProjectSecrets): Promise<Project>
  get(ref: string): Promise<Project | null>
  list(): Promise<Project[]>
  listByStatus(statuses: ProjectStatus[]): Promise<Project[]>
  update(ref: string, update: ProjectUpdate): Promise<void>
  getSecrets(ref: string): Promise<ProjectSecrets | null>
  delete(ref: string): Promise<void>
  ping(): Promise<void>
}

const MIGRATION = `
create schema if not exists _platform;

create table if not exists _platform.projects (
  ref text primary key,
  name text not null,
  status text not null check (status in (${STATUSES.map((s) => `'${s}'`).join(', ')})),
  coolify_service_uuid text,
  step text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_error text
);

-- Every column is AES-256-GCM ciphertext (see src/secrets.ts), never plain text.
create table if not exists _platform.project_secrets (
  ref text primary key references _platform.projects (ref) on delete cascade,
  db_password text not null,
  jwt_secret text not null,
  anon_key text not null,
  service_key text not null,
  s3_access_key text not null,
  s3_secret_key text not null
);
`

const PROJECT_COLUMNS =
  'ref, name, status, coolify_service_uuid, step, created_at, updated_at, last_error'

/** Idempotent; an advisory lock keeps two starting instances from racing. */
export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select pg_advisory_xact_lock(hashtext('_platform.migrate'))")
    await client.query(MIGRATION)
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

export function createPgRegistry(pool: pg.Pool, key: Buffer): Registry {
  return {
    async insert(project, secrets) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const { rows } = await client.query<Project>(
          `insert into _platform.projects (ref, name, status) values ($1, $2, 'CREATING') returning ${PROJECT_COLUMNS}`,
          [project.ref, project.name]
        )
        await client.query(
          `insert into _platform.project_secrets (ref, ${SECRET_COLUMNS.join(', ')}) values ($1, ${SECRET_COLUMNS.map((_, i) => `$${i + 2}`).join(', ')})`,
          [
            project.ref,
            ...SECRET_COLUMNS.map((c) => encrypt(secrets[c], key, `${project.ref}:${c}`)),
          ]
        )
        await client.query('commit')
        return rows[0]
      } catch (err) {
        await client.query('rollback')
        throw err
      } finally {
        client.release()
      }
    },

    async get(ref) {
      const { rows } = await pool.query<Project>(
        `select ${PROJECT_COLUMNS} from _platform.projects where ref = $1`,
        [ref]
      )
      return rows[0] ?? null
    },

    async list() {
      const { rows } = await pool.query<Project>(
        `select ${PROJECT_COLUMNS} from _platform.projects order by created_at`
      )
      return rows
    },

    async listByStatus(statuses) {
      const { rows } = await pool.query<Project>(
        `select ${PROJECT_COLUMNS} from _platform.projects where status = any($1) order by created_at`,
        [statuses]
      )
      return rows
    },

    async update(ref, update) {
      const entries = Object.entries(update)
      if (entries.length === 0) return
      const sets = entries.map(([column], i) => `${column} = $${i + 2}`)
      await pool.query(
        `update _platform.projects set ${sets.join(', ')}, updated_at = now() where ref = $1`,
        [ref, ...entries.map(([, value]) => value)]
      )
    },

    async getSecrets(ref) {
      const { rows } = await pool.query<Record<string, string>>(
        `select ${SECRET_COLUMNS.join(', ')} from _platform.project_secrets where ref = $1`,
        [ref]
      )
      if (!rows[0]) return null
      const row = rows[0]
      return Object.fromEntries(
        SECRET_COLUMNS.map((c) => [c, decrypt(row[c], key, `${ref}:${c}`)])
      ) as ProjectSecrets
    },

    async delete(ref) {
      // project_secrets goes with it (on delete cascade).
      await pool.query('delete from _platform.projects where ref = $1', [ref])
    },

    async ping() {
      await pool.query('select 1')
    },
  }
}
