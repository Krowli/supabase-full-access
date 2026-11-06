import { StackInputError, StackNotFoundError } from './stack.ts'
import type { Docker, Stacks } from './stacks.ts'
import {
  BACKUP_NAME,
  checkSettings,
  CONFIG_DIR,
  parseBackupList,
  PGDATA,
  SCRATCH_SCRIPT,
  scratchName,
  scratchVolume,
  TARGET_TIME,
  WALG_CONF,
  WALG_CONF_OFF_TEXT,
  WALG_CONF_TEXT,
  WALG_JSON,
  walgArgs,
  walgJson,
  writeFileScript,
  type BaseBackup,
} from './walg.ts'

export type PitrConfig = {
  stacks: Stacks
  docker: Docker
  /** The network the backup service reaches databases on; the copy joins it under its name. */
  sharedNetwork: string
  /** How long a copy may take to fetch and replay before it counts as failed. */
  scratchTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

const dbContainer = (id: string) => `supabase-db-${id}`
const READY_SQL = 'select pg_is_in_recovery()::text || pg_get_wal_replay_pause_state()'

/**
 * What the backup service may ask of a project database for point-in-time recovery, and nothing
 * more: wal-g's files, a base backup, the list of base backups, and a read-only copy at a moment.
 * No command line from the caller ever reaches Docker.
 */
export class Pitr {
  private config: PitrConfig

  constructor(config: PitrConfig) {
    this.config = config
  }

  private async db(id: string): Promise<string> {
    if (!(await this.config.stacks.has(id))) throw new StackNotFoundError(`No stack ${id}`)
    return dbContainer(id)
  }

  /** Writes wal-g.json and wal-g.conf into the project's config volume, then reloads Postgres. */
  async configure(id: string, input: unknown): Promise<void> {
    const settings = checkSettings(input)
    const db = await this.db(id)
    const { docker } = this.config
    await docker.exec(db, 'postgres', writeFileScript(WALG_JSON, '600'), walgJson(settings))
    await docker.exec(db, 'postgres', writeFileScript(WALG_CONF, '644'), WALG_CONF_TEXT)
    // archive_command applies on a reload; archive_mode waits for the next restart.
    await docker.signal(db, 'HUP')
  }

  /** PITR off: no more archiving (fully at the next restart), wal-g.json and its keys gone. */
  async disable(id: string): Promise<void> {
    const db = await this.db(id)
    const { docker } = this.config
    await docker.exec(db, 'postgres', writeFileScript(WALG_CONF, '644'), WALG_CONF_OFF_TEXT)
    await docker.exec(db, 'postgres', ['rm', '-f', WALG_JSON])
    await docker.signal(db, 'HUP')
  }

  /** A full backup, then only the newest `keepFull` stay (with the WAL they need). */
  async backup(id: string, keepFull: number): Promise<BaseBackup[]> {
    if (!Number.isInteger(keepFull) || keepFull < 1 || keepFull > 60)
      throw new StackInputError('keep_full must be 1 to 60')
    const db = await this.db(id)
    const { docker } = this.config
    await docker.exec(db, 'postgres', walgArgs('backup-push', PGDATA), undefined, 2 * 60 * 60_000)
    await docker.exec(
      db,
      'postgres',
      walgArgs('delete', 'retain', 'FULL', String(keepFull), '--confirm'),
      undefined,
      30 * 60_000
    )
    return this.backups(id)
  }

  async backups(id: string): Promise<BaseBackup[]> {
    const db = await this.db(id)
    return parseBackupList(
      await this.config.docker.exec(db, 'postgres', walgArgs('backup-list', '--json', '--detail'))
    )
  }

  /**
   * Starts the copy of stack <id>'s database at `targetTime` from base backup `backupName` and
   * resolves with its host name once it has replayed up to that moment and paused. Any earlier copy
   * of this stack goes first. The copy reads the project's config volume (wal-g.json, the pgsodium
   * key) read-only and keeps its data in a volume of its own.
   */
  async startScratch(id: string, backupName: string, targetTime: string): Promise<string> {
    if (!BACKUP_NAME.test(backupName)) throw new StackInputError('Invalid backup name')
    if (!TARGET_TIME.test(targetTime) || Number.isNaN(Date.parse(targetTime)))
      throw new StackInputError('Invalid target time')
    const db = await this.db(id)
    const { docker, sharedNetwork } = this.config
    const name = scratchName(id)
    const image = await docker.imageOf(db)
    await this.dropScratch(id)
    await docker.run([
      '--name',
      name,
      '--label',
      `supa.pitr=${id}`,
      '--memory',
      '1g',
      '--network',
      sharedNetwork,
      '-v',
      `${scratchVolume(id)}:${PGDATA}`,
      '-v',
      `${id}_supabase-db-config:${CONFIG_DIR}:ro`,
      '-e',
      `PITR_BACKUP=${backupName}`,
      // recovery_target_time takes "2026-11-06 12:19:22.100+00", not ISO 8601's T and Z.
      '-e',
      `PITR_TARGET=${targetTime.replace('T', ' ').replace(/Z$/, '+00')}`,
      '--entrypoint',
      'bash',
      image,
      '-c',
      SCRATCH_SCRIPT,
    ])
    const sleep = this.config.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    const deadline = Date.now() + (this.config.scratchTimeoutMs ?? 60 * 60_000)
    while (Date.now() < deadline) {
      if (!(await docker.running(name))) {
        // Its last lines say why (Postgres's FATAL comes after wal-g's progress lines).
        const logs = (await docker.logs(name, 8)).trim().split('\n').slice(-2).join(' | ')
        await this.dropScratch(id)
        throw new Error(`The copy at ${targetTime} stopped: ${logs.slice(-400)}`)
      }
      const state = await docker
        .exec(
          name,
          'postgres',
          [
            'psql',
            '-h',
            '127.0.0.1',
            '-U',
            'supabase_admin',
            '-d',
            'postgres',
            '-At',
            '-c',
            READY_SQL,
          ],
          undefined,
          30_000
        )
        .catch(() => '')
      if (state.trim() === 'truepaused') return name
      await sleep(3000)
    }
    await this.dropScratch(id)
    throw new Error(`The copy at ${targetTime} was not ready in time`)
  }

  async dropScratch(id: string): Promise<void> {
    await this.config.docker.remove(scratchName(id), [scratchVolume(id)])
  }
}
