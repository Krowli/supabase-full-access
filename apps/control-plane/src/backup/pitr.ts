// Point-in-time recovery as the backup service runs it (deploy/platform/SPEC.md §22): it holds the
// settings and the schedule, the runner does what needs Docker (src/runner/pitr.ts). Postgres
// archives every WAL file itself (archive_command); here: a base backup a day, the archive's
// health, and "restore into a new project at a moment".

import type { BaseBackup, WalgSettings } from '../runner/walg.ts'
import { must, type Exec } from './exec.ts'
import { pgEnv, type ProjectDb } from './jobs.ts'
import { latestSlot } from './schedule.ts'

/** The runner's PITR calls (src/runner/server.ts), by stack id. */
export type PitrRunner = {
  configure(stackId: string, settings: WalgSettings): Promise<void>
  backup(stackId: string, keepFull: number): Promise<BaseBackup[]>
  backups(stackId: string): Promise<BaseBackup[]>
  /** Resolves with the host of a read-only copy at `targetTime`, paused there. */
  startScratch(stackId: string, backupName: string, targetTime: string): Promise<string>
  dropScratch(stackId: string): Promise<void>
}

export type ArchiveStatus = {
  archiveMode: boolean
  lastArchivedWal: string | null
  lastArchivedAt: Date | null
  failedCount: number
  lastFailedAt: Date | null
}

/** What the service knows of one project's PITR, kept in memory and refreshed every few minutes. */
export type PitrState = {
  checkedAt: Date | null
  /** sha256 of the settings last written to the database; null: write them. */
  configured: string | null
  archive: ArchiveStatus | null
  /** When archive_mode was first seen on. */
  archiveOnSince: Date | null
  backups: BaseBackup[] | null
  /** The last base backup tried, and why it failed (cleared by the next one that works). */
  lastAttempt: Date | null
  backupError: string | null
  /** Why the last refresh (settings, archive status, list) failed; cleared by the next one. */
  refreshError: string | null
  busy: boolean
}

export const newPitrState = (): PitrState => ({
  checkedAt: null,
  configured: null,
  archive: null,
  archiveOnSince: null,
  backups: null,
  lastAttempt: null,
  backupError: null,
  refreshError: null,
  busy: false,
})

const epoch = (v: string) => (v ? new Date(Number(v) * 1000) : null)

export async function archiveStatus(exec: Exec, db: ProjectDb): Promise<ArchiveStatus> {
  const sql = `select current_setting('archive_mode'), coalesce(last_archived_wal, ''),
    coalesce(extract(epoch from last_archived_time)::text, ''), failed_count,
    coalesce(extract(epoch from last_failed_time)::text, '') from pg_stat_archiver`
  const r = await must(exec, 'Read the WAL archive status', 'psql', ['-At', '-F', '|', '-c', sql], { env: pgEnv(db), timeoutMs: 30_000 })
  const [mode, wal, archivedAt, failed, failedAt] = r.stdout.trim().split('|')
  return {
    archiveMode: mode === 'on' || mode === 'always',
    lastArchivedWal: wal || null,
    lastArchivedAt: epoch(archivedAt),
    failedCount: Number(failed) || 0,
    lastFailedAt: epoch(failedAt),
  }
}

/**
 * Makes everything up to now restorable before a restore: a transaction (so a commit lies after any
 * moment asked for; recovery stops at the first commit past it), then a WAL switch, then wait until
 * Postgres has archived that file.
 */
export async function sealArchive(
  exec: Exec,
  db: ProjectDb,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 3 * 60_000
): Promise<void> {
  const env = pgEnv(db)
  await must(exec, 'Write a commit', 'psql', ['-At', '-c', 'select txid_current()'], { env })
  const r = await must(exec, 'Switch the WAL file', 'psql', ['-At', '-c', 'select pg_walfile_name(pg_switch_wal())'], { env })
  const wal = r.stdout.trim()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await archiveStatus(exec, db)
    if (s.lastArchivedWal && s.lastArchivedWal >= wal) return
    await sleep(3000)
  }
  throw new Error(`WAL file ${wal} was not archived within ${Math.round(timeoutMs / 60_000)} minutes`)
}

/** The newest base backup that finished before the moment: recovery replays WAL from there. */
export function backupBefore(backups: BaseBackup[], moment: Date): BaseBackup | null {
  const before = backups.filter((b) => Date.parse(b.finish_time) < moment.getTime())
  return before.at(-1) ?? null
}

/**
 * Whether today's base backup is due: archiving is on and no base backup finished since the latest
 * scheduled moment, and none was tried since (a failed one waits for the next day, as restic's do).
 */
export function pitrBackupDue(now: Date, schedule: string, s: PitrState): boolean {
  if (!s.archive?.archiveMode || s.busy || s.backups === null) return false
  const slot = latestSlot(now, schedule)
  const newest = s.backups.at(-1)
  if (newest && Date.parse(newest.finish_time) >= slot.getTime()) return false
  if (!newest) return s.lastAttempt === null || now.getTime() - s.lastAttempt.getTime() > 60 * 60_000
  return s.lastAttempt === null || s.lastAttempt < slot
}

const FAILING_MS = 10 * 60_000
const GRACE_MS = 60 * 60_000

/** /health lines for one project; none while it waits for the restart that turns archiving on. */
export function pitrProblems(now: Date, id: string, schedule: string, s: PitrState): string[] {
  const problems: string[] = []
  if (s.refreshError) problems.push(`${id}: point-in-time recovery: ${s.refreshError}`)
  if (s.backupError) problems.push(`${id}: last base backup failed: ${s.backupError}`)
  const a = s.archive
  if (!a?.archiveMode) return problems
  const archivedAt = a.lastArchivedAt ?? s.archiveOnSince
  if (a.lastFailedAt && (!a.lastArchivedAt || a.lastFailedAt > a.lastArchivedAt) && archivedAt && now.getTime() - archivedAt.getTime() > FAILING_MS)
    problems.push(`${id}: WAL archiving fails since ${archivedAt.toISOString()}`)
  const newest = s.backups?.at(-1)
  const expected = latestSlot(new Date(now.getTime() - GRACE_MS), schedule)
  if (newest && Date.parse(newest.finish_time) < expected.getTime())
    problems.push(`${id}: no base backup since ${newest.finish_time}`)
  return problems
}

/** What Studio's Backups page shows of PITR. No keys. */
export function pitrView(now: Date, s: PitrState | undefined) {
  const a = s?.archive ?? null
  const failing = Boolean(a?.lastFailedAt && (!a.lastArchivedAt || a.lastFailedAt > a.lastArchivedAt))
  const backups = s?.backups ?? []
  return {
    archive_mode: a ? (a.archiveMode ? 'on' : 'off') : null,
    waiting_for_restart: a ? !a.archiveMode : false,
    failing,
    last_archived_at: a?.lastArchivedAt?.toISOString() ?? null,
    // From the first base backup to now (a restore seals the archive first), or to the last
    // archived file while archiving fails.
    earliest: backups[0]?.finish_time ?? null,
    latest: !a?.archiveMode || !backups.length ? null : failing ? (a.lastArchivedAt?.toISOString() ?? null) : now.toISOString(),
    backups: backups.map((b) => ({ name: b.name, finish_time: b.finish_time, compressed_size: b.compressed_size })),
    last_error: s?.refreshError ?? s?.backupError ?? null,
    checked_at: s?.checkedAt?.toISOString() ?? null,
  }
}
