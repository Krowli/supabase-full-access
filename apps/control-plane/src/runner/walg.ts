// Point-in-time recovery of a project database with wal-g (deploy/platform/SPEC.md §22). The
// project image (supabase/postgres) ships wal-g and its postgresql.conf includes
// /etc/postgresql-custom/wal-g.conf, which lives in the project's own config volume: the runner
// writes the archive settings there and wal-g's settings next to it, and the template stays as it is.

import { StackInputError } from './stack.ts'

/** Where one project's WAL and base backups go, and the key they are encrypted with. */
export type WalgSettings = {
  /** s3://<bucket>/<prefix>/<ref>: one folder per project. */
  prefix: string
  endpoint: string
  region: string
  access_key_id: string
  secret_access_key: string
  /** 32 bytes as 64 hex characters (libsodium). */
  libsodium_key: string
}

/** A full (base) backup as `wal-g backup-list --json --detail` describes it. */
export type BaseBackup = {
  name: string
  start_time: string
  finish_time: string
  compressed_size: number | null
  uncompressed_size: number | null
}

export const CONFIG_DIR = '/etc/postgresql-custom'
export const WALG_JSON = `${CONFIG_DIR}/wal-g.json`
export const WALG_CONF = `${CONFIG_DIR}/wal-g.conf`
export const PGDATA = '/var/lib/postgresql/data'
const WALG = '/usr/local/bin/wal-g'

const S3_PREFIX = /^s3:\/\/[a-z0-9][a-z0-9.-]{1,62}(\/[A-Za-z0-9_.-]+)+$/
const ENDPOINT = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/
const REGION = /^[a-z0-9-]{1,32}$/
const KEY_ID = /^[A-Za-z0-9+/=_.-]{1,256}$/
const HEX_KEY = /^[0-9a-f]{64}$/
export const BACKUP_NAME = /^base_[0-9A-F]{24}(_D_[0-9A-F]{24})?$/
export const TARGET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

export function checkSettings(input: unknown): WalgSettings {
  const s = (input ?? {}) as Record<string, unknown>
  const field = (key: keyof WalgSettings, pattern: RegExp) => {
    const v = s[key]
    if (typeof v !== 'string' || !pattern.test(v) || v.includes('..')) throw new StackInputError(`wal-g setting ${key} is missing or invalid`)
    return v
  }
  return {
    prefix: field('prefix', S3_PREFIX),
    endpoint: field('endpoint', ENDPOINT),
    region: field('region', REGION),
    access_key_id: field('access_key_id', KEY_ID),
    secret_access_key: field('secret_access_key', KEY_ID),
    libsodium_key: field('libsodium_key', HEX_KEY),
  }
}

/** wal-g.json (mode 600, the postgres user's): wal-g reads it on every archive call and backup. */
export function walgJson(s: WalgSettings): string {
  return (
    JSON.stringify(
      {
        WALG_S3_PREFIX: s.prefix,
        AWS_ENDPOINT: s.endpoint,
        AWS_REGION: s.region,
        AWS_S3_FORCE_PATH_STYLE: 'true',
        AWS_ACCESS_KEY_ID: s.access_key_id,
        AWS_SECRET_ACCESS_KEY: s.secret_access_key,
        WALG_LIBSODIUM_KEY: s.libsodium_key,
        WALG_LIBSODIUM_KEY_TRANSFORM: 'hex',
        WALG_COMPRESSION_METHOD: 'zstd',
        // backup-push talks to the server it copies; pg_hba trusts 127.0.0.1 in this image.
        PGHOST: '127.0.0.1',
        PGPORT: '5432',
        PGUSER: 'supabase_admin',
        PGDATABASE: 'postgres',
      },
      null,
      2
    ) + '\n'
  )
}

/**
 * wal-g.conf: archive every WAL file, and at least once a minute, so at most a minute of changes
 * is lost. archive_mode takes effect at the database's next restart; the rest on a reload.
 * `hot_standby = off` is the image's own line in this file.
 */
export const WALG_CONF_TEXT = `# Written by the platform's runner (point-in-time recovery); rewritten on every change.
archive_mode = on
archive_command = '${WALG} wal-push "%p" --config ${WALG_JSON}'
archive_timeout = 60
hot_standby = off
`

/**
 * wal-g.conf with PITR off: archive_mode goes off at the next restart; until then every WAL file
 * counts as archived and is dropped (an empty archive_command would make Postgres keep them all).
 */
export const WALG_CONF_OFF_TEXT = `# Written by the platform's runner: point-in-time recovery off.
archive_mode = off
archive_command = '/bin/true'
hot_standby = off
`

/** Writes a file of the config volume as the postgres user, atomically, from stdin. */
export function writeFileScript(path: string, mode: '600' | '644'): string[] {
  return ['sh', '-c', `umask 077 && cat > ${path}.tmp && chmod ${mode} ${path}.tmp && mv ${path}.tmp ${path}`]
}

export function walgArgs(...args: string[]): string[] {
  return [WALG, ...args, '--config', WALG_JSON]
}

/** The one-off copy of a project's database at a moment: its names, from the stack id. */
export const scratchName = (id: string) => `pitr-${id}`
export const scratchVolume = (id: string) => `pitr-${id}-data`

/**
 * The copy's entrypoint (root, then the postgres user): fetch the base backup into an empty data
 * directory, replay WAL from the archive up to the moment and pause there. A paused server is a
 * read-only standby: pg_cron and pg_net do not run, nothing is written, nothing is archived
 * (archive_mode=off), and the source's folder in the archive is only ever read.
 */
export const SCRATCH_SCRIPT = `set -eu
d=${PGDATA}
chown postgres:postgres "$d" && chmod 700 "$d"
gosu postgres ${WALG} backup-fetch "$d" "$PITR_BACKUP" --config ${WALG_JSON}
gosu postgres touch "$d/recovery.signal"
exec gosu postgres postgres -c config_file=/etc/postgresql/postgresql.conf -c archive_mode=off -c hot_standby=on \\
  -c "restore_command=${WALG} wal-fetch %f %p --config ${WALG_JSON}" \\
  -c "recovery_target_time=$PITR_TARGET" -c recovery_target_action=pause
`

/** `wal-g backup-list --json --detail` → base backups, oldest first ("No backups found" is []). */
export function parseBackupList(stdout: string): BaseBackup[] {
  const text = stdout.trim()
  if (!text.startsWith('[')) return []
  const list = JSON.parse(text) as {
    backup_name: string
    start_time: string
    finish_time: string
    compressed_size?: number
    uncompressed_size?: number
  }[]
  return list
    .map((b) => ({
      name: b.backup_name,
      start_time: b.start_time,
      finish_time: b.finish_time,
      compressed_size: b.compressed_size ?? null,
      uncompressed_size: b.uncompressed_size ?? null,
    }))
    .sort((a, b) => (a.finish_time < b.finish_time ? -1 : 1))
}
