// The backup service's record of its runs, in the platform database next to the project registry.

import pg from 'pg'

export const RUN_KINDS = ['scheduled', 'manual', 'restore'] as const
export type RunKind = (typeof RUN_KINDS)[number]
export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export type Run = {
  id: number
  /** The project (its ref) or `_platform` for the platform's own database. */
  ref: string
  kind: RunKind
  status: RunStatus
  destination: string | null
  snapshot_id: string | null
  size_bytes: number | null
  /** A restore: the project it restored into. */
  target_ref: string | null
  error: string | null
  /** A restore that finished with problems worth reading. */
  warnings: string | null
  started_at: Date | null
  finished_at: Date | null
  created_at: Date
}

const MIGRATION = `
create schema if not exists _platform;
create table if not exists _platform.backup_runs (
  id bigserial primary key,
  ref text not null,
  kind text not null check (kind in (${RUN_KINDS.map((k) => `'${k}'`).join(', ')})),
  status text not null check (status in (${RUN_STATUSES.map((s) => `'${s}'`).join(', ')})),
  destination text,
  snapshot_id text,
  size_bytes bigint,
  target_ref text,
  error text,
  warnings text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists backup_runs_ref_idx on _platform.backup_runs (ref, created_at desc);
-- Projects that have backups but are gone from the registry: when that was first seen, and when
-- their backups were removed (deleted_project_retention_days later).
create table if not exists _platform.backup_deleted_projects (
  ref text primary key,
  destination text not null,
  deleted_at timestamptz not null,
  removed_at timestamptz
);
`

const COLUMNS =
  'id, ref, kind, status, destination, snapshot_id, size_bytes::float8 as size_bytes, target_ref, error, warnings, started_at, finished_at, created_at'

export type RunUpdate = Partial<
  Pick<Run, 'status' | 'destination' | 'snapshot_id' | 'size_bytes' | 'target_ref' | 'error' | 'warnings' | 'started_at' | 'finished_at'>
>

export interface RunStore {
  insert(run: { ref: string; kind: RunKind; destination?: string | null }): Promise<Run>
  update(id: number, update: RunUpdate): Promise<void>
  get(id: number): Promise<Run | null>
  list(ref: string, limit: number): Promise<Run[]>
  /** Runs left queued or running by a process that stopped: they will never finish. */
  failInterrupted(): Promise<number>
  /** Every ref with a backup, and the destination of its last one. */
  backedUp(): Promise<{ ref: string; destination: string }[]>
  /** Records that a project with backups is gone; the first time counts. */
  noticeDeleted(ref: string, destination: string, at: Date): Promise<void>
  /** Deleted projects whose backups are not removed yet. */
  deletedPending(): Promise<{ ref: string; destination: string; deleted_at: Date }[]>
  markRemoved(ref: string, at: Date): Promise<void>
  /** For the schedule and /health: the last scheduled start, the last run and the last success. */
  summary(ref: string): Promise<{
    lastScheduledStart: Date | null
    last: Run | null
    lastSuccess: Date | null
  }>
}

export async function migrateRuns(pool: pg.Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select pg_advisory_xact_lock(hashtext('_platform.backup_runs'))")
    await client.query(MIGRATION)
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

export function createRunStore(pool: pg.Pool): RunStore {
  return {
    async insert(run) {
      const { rows } = await pool.query<Run>(
        `insert into _platform.backup_runs (ref, kind, status, destination) values ($1, $2, 'queued', $3) returning ${COLUMNS}`,
        [run.ref, run.kind, run.destination ?? null]
      )
      return rows[0]
    },

    async update(id, update) {
      const entries = Object.entries(update)
      if (entries.length === 0) return
      const sets = entries.map(([column], i) => `${column} = $${i + 2}`)
      await pool.query(`update _platform.backup_runs set ${sets.join(', ')} where id = $1`, [
        id,
        ...entries.map(([, value]) => value),
      ])
    },

    async get(id) {
      const { rows } = await pool.query<Run>(`select ${COLUMNS} from _platform.backup_runs where id = $1`, [id])
      return rows[0] ?? null
    },

    async list(ref, limit) {
      const { rows } = await pool.query<Run>(
        `select ${COLUMNS} from _platform.backup_runs where ref = $1 order by created_at desc limit $2`,
        [ref, limit]
      )
      return rows
    },

    async failInterrupted() {
      const { rowCount } = await pool.query(
        `update _platform.backup_runs set status = 'failed', error = 'Interrupted: the backup service restarted', finished_at = now()
         where status in ('queued', 'running')`
      )
      return rowCount ?? 0
    },

    async backedUp() {
      const { rows } = await pool.query<{ ref: string; destination: string }>(
        `select distinct on (ref) ref, destination from _platform.backup_runs
         where kind <> 'restore' and status = 'succeeded' and destination is not null
         order by ref, created_at desc`
      )
      return rows
    },

    async noticeDeleted(ref, destination, at) {
      await pool.query(
        `insert into _platform.backup_deleted_projects (ref, destination, deleted_at) values ($1, $2, $3)
         on conflict (ref) do nothing`,
        [ref, destination, at]
      )
    },

    async deletedPending() {
      const { rows } = await pool.query<{ ref: string; destination: string; deleted_at: Date }>(
        `select ref, destination, deleted_at from _platform.backup_deleted_projects where removed_at is null order by deleted_at`
      )
      return rows
    },

    async markRemoved(ref, at) {
      await pool.query(`update _platform.backup_deleted_projects set removed_at = $2 where ref = $1`, [ref, at])
    },

    async summary(ref) {
      const { rows } = await pool.query<{
        last_scheduled_start: Date | null
        last_success: Date | null
      }>(
        `select
           (select max(coalesce(started_at, created_at)) from _platform.backup_runs where ref = $1 and kind = 'scheduled') as last_scheduled_start,
           (select max(finished_at) from _platform.backup_runs where ref = $1 and kind <> 'restore' and status = 'succeeded') as last_success`,
        [ref]
      )
      const { rows: last } = await pool.query<Run>(
        `select ${COLUMNS} from _platform.backup_runs where ref = $1 and kind <> 'restore' and status in ('succeeded', 'failed')
         order by created_at desc limit 1`,
        [ref]
      )
      return {
        lastScheduledStart: rows[0]?.last_scheduled_start ?? null,
        lastSuccess: rows[0]?.last_success ?? null,
        last: last[0] ?? null,
      }
    },
  }
}
