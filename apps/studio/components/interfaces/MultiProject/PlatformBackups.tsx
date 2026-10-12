import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Input } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { ConfirmationModal } from 'ui-patterns/Dialogs/ConfirmationModal'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { AlertError } from '@/components/ui/AlertError'
import {
  usePlatformBackupRestoreMutation,
  usePlatformBackupRunMutation,
  usePlatformBackupsQuery,
  type PlatformBackupRun,
  type PlatformBackupSnapshot,
} from '@/data/platform-backups/platform-backups'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'

/**
 * Fork: Database → Backups on a multi-project Studio (deploy/platform/SPEC.md §19). The platform's
 * backup service copies the project every night (database, Storage files, settings) to the place
 * the infra repository names for it. Here: where and when, what happened lately, the backups, "Back
 * up now", and restoring a backup into a new project next to this one. No keys are shown or set
 * here; they live in the infra repository.
 */

const formatTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '')

export const formatBytes = (n: number | null) => {
  if (n === null) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

const RUN_LABEL: Record<PlatformBackupRun['kind'], string> = {
  scheduled: 'Nightly backup',
  manual: 'Backup',
  restore: 'Restore',
}

const StatusBadge = ({ status }: { status: PlatformBackupRun['status'] }) => (
  <Badge variant={status === 'failed' ? 'destructive' : status === 'succeeded' ? 'success' : 'default'}>
    {status === 'queued' ? 'Waiting' : status === 'running' ? 'Running' : status === 'succeeded' ? 'Done' : 'Failed'}
  </Badge>
)

export const PlatformBackups = () => {
  const { data: project } = useSelectedProjectQuery()
  const ref = project?.ref
  const { data, error, isPending, isError } = usePlatformBackupsQuery(ref)
  const { mutate: runBackup, isPending: isStarting } = usePlatformBackupRunMutation(ref)
  const [selected, setSelected] = useState<PlatformBackupSnapshot | null>(null)

  if (isPending) return <GenericSkeletonLoader />
  if (isError) return <AlertError error={error} subject="Failed to retrieve backups" />

  const busy = data.runs.some((r) => r.status === 'queued' || r.status === 'running')
  const lastBackup = data.runs.find((r) => r.kind !== 'restore' && (r.status === 'succeeded' || r.status === 'failed'))

  return (
    <div className="flex flex-col gap-y-6">
      {!data.configured ? (
        <Admonition
          type="warning"
          title="Backups are off"
          description={data.config_error ?? 'No backup configuration'}
        />
      ) : (
        <>
          {data.config_error && (
            <Admonition type="warning" title="The backup configuration has a problem" description={data.config_error} />
          )}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border p-4">
            <div className="flex flex-col gap-1 text-sm">
              {data.enabled ? (
                <p className="text-foreground">
                  Every day at {data.schedule} UTC to <span className="font-mono">{data.destination}</span>
                </p>
              ) : (
                <p className="text-foreground">Nightly backups are switched off for this project</p>
              )}
              {data.keep && (
                <p className="text-foreground-light">
                  Keeps {data.keep.daily} daily, {data.keep.weekly} weekly and {data.keep.monthly} monthly
                  backups. Encrypted before they leave the server.
                </p>
              )}
              {lastBackup && (
                <p className={lastBackup.status === 'failed' ? 'text-destructive' : 'text-foreground-light'}>
                  {lastBackup.status === 'failed'
                    ? `Last backup failed (${formatTime(lastBackup.finished_at)}): ${lastBackup.error}`
                    : `Last backup: ${formatTime(lastBackup.finished_at)}`}
                </p>
              )}
              {data.config_note && <p className="text-foreground-lighter">{data.config_note}</p>}
            </div>
            <Button
              variant="default"
              loading={isStarting}
              disabled={busy || isStarting}
              onClick={() =>
                runBackup(undefined, {
                  onSuccess: () => toast.success('Backup started'),
                  onError: (e) => toast.error(`Could not start a backup: ${e.message}`),
                })
              }
            >
              Back up now
            </Button>
          </div>
        </>
      )}

      {data.runs.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm text-foreground">Recent activity</h3>
          <ul className="divide-y rounded-md border text-sm">
            {data.runs.slice(0, 8).map((run) => (
              <li key={run.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                <StatusBadge status={run.status} />
                <span className="text-foreground">{RUN_LABEL[run.kind]}</span>
                <span className="text-foreground-light">{formatTime(run.started_at ?? run.created_at)}</span>
                {run.kind === 'restore' && run.target_ref && (
                  <Link className="text-brand hover:underline" href={`/project/${run.target_ref}`}>
                    New project {run.target_ref}
                  </Link>
                )}
                {run.status === 'failed' && run.error && <span className="text-destructive">{run.error}</span>}
                {run.warnings && (
                  <span className="text-warning" title={run.warnings}>
                    Finished with {run.warnings.split('\n').length} warning(s)
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.configured && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm text-foreground">Backups</h3>
          {data.snapshots_error ? (
            <Admonition type="warning" title="Could not list the backups" description={data.snapshots_error} />
          ) : data.snapshots.length === 0 ? (
            <p className="text-sm text-foreground-light">No backups yet.</p>
          ) : (
            <ul className="divide-y rounded-md border text-sm">
              {data.snapshots.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-4 px-4 py-2">
                  <span className="text-foreground">{formatTime(s.time)}</span>
                  <span className="text-foreground-light">{formatBytes(s.size_bytes)}</span>
                  <Button variant="default" disabled={busy} onClick={() => setSelected(s)}>
                    Restore into new project
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {selected && project && (
        <RestoreDialog
          snapshot={selected}
          projectName={project.name}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

const RestoreDialog = ({
  snapshot,
  projectName,
  onClose,
}: {
  snapshot: PlatformBackupSnapshot
  projectName: string
  onClose: () => void
}) => {
  const { data: project } = useSelectedProjectQuery()
  const { mutate: restore, isPending } = usePlatformBackupRestoreMutation(project?.ref)
  const [name, setName] = useState(`${projectName} (restored ${snapshot.time.slice(0, 10)})`.slice(0, 64))

  return (
    <ConfirmationModal
      visible
      size="medium"
      title="Restore into a new project"
      confirmLabel="Create project and restore"
      loading={isPending}
      disabled={!name.trim()}
      onCancel={() => {
        if (!isPending) onClose()
      }}
      onConfirm={() =>
        restore(
          { snapshotId: snapshot.id, name: name.trim() },
          {
            onSuccess: () => {
              toast.success('Restoring into a new project. It shows up in the project list in a few minutes.')
              onClose()
            },
            onError: (e) => toast.error(`Could not start the restore: ${e.message}`),
          }
        )
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-foreground-light">
          A new project gets the database, users, Storage files and settings of {projectName} as of{' '}
          {formatTime(snapshot.time)}. {projectName} itself is not changed. The new project has its own
          address and API keys; users sign in again there.
        </p>
        <label className="flex flex-col gap-1">
          <span className="text-foreground">Name of the new project</span>
          <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
    </ConfirmationModal>
  )
}
