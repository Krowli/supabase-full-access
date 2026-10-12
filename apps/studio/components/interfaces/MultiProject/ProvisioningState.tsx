import { useState } from 'react'
import { Button, CriticalIcon } from 'ui'

import { MultiProjectDeleteDialog } from './MultiProjectDeleteDialog'
import BuildingState from '@/components/layouts/ProjectLayout/BuildingState'
import { useProjectRetryMutation } from '@/data/projects/project-retry-mutation'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { PROJECT_STATUS } from '@/lib/constants'

/**
 * Fork: what a multi-project Studio shows for a project the control plane is still setting up, or
 * failed to (deploy/platform/SPEC.md M6). `ProjectLayout` shows it on every page that needs the
 * database, the project home included: upstream's home draws a project that is coming up as a
 * dimmed dashboard, whose every read fails for a project that has no stack yet.
 *
 * - `COMING_UP` and `UNKNOWN`: upstream's building screen. It polls `/status` every 4 s and reloads
 *   the project once that reads `ACTIVE_HEALTHY`.
 * - `INIT_FAILED`: the control plane stopped at a step. Retry runs the steps again (each is
 *   idempotent); delete removes what was built.
 */

const PROVISIONING_STATUSES: string[] = [
  PROJECT_STATUS.COMING_UP,
  PROJECT_STATUS.UNKNOWN,
  PROJECT_STATUS.INIT_FAILED,
]

export const isProvisioning = (status: string | undefined) =>
  status !== undefined && PROVISIONING_STATUSES.includes(status)

export const ProvisioningState = ({ status }: { status: string | undefined }) =>
  status === PROJECT_STATUS.INIT_FAILED ? <ProvisioningFailedState /> : <BuildingState />

export const ProvisioningFailedState = () => {
  const { data: project } = useSelectedProjectQuery()
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const { mutate: retry, isPending: isRetrying } = useProjectRetryMutation()

  return (
    <>
      <div className="flex items-center justify-center h-full">
        <div className="bg-surface-100 border border-overlay rounded-md w-3/4 lg:w-1/2">
          <div className="space-y-6 pt-6">
            <div className="flex px-8 space-x-8">
              <div className="mt-1">
                <CriticalIcon className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <p>Setting up {project?.name ?? 'this project'} failed</p>
                <p className="text-sm text-foreground-light">
                  One of the steps that create the project's database, services and routes did not
                  finish. Retry runs them again; each step is safe to repeat. The control plane's
                  log names the step that failed and why.
                </p>
              </div>
            </div>

            <div className="border-t border-overlay flex items-center justify-end gap-x-2 py-4 px-8">
              <Button variant="default" disabled={isRetrying} onClick={() => setIsDeleteOpen(true)}>
                Delete project
              </Button>
              <Button
                variant="primary"
                loading={isRetrying}
                onClick={() => {
                  if (project) retry({ projectRef: project.ref })
                }}
              >
                Retry
              </Button>
            </div>
          </div>
        </div>
      </div>
      <MultiProjectDeleteDialog visible={isDeleteOpen} onClose={() => setIsDeleteOpen(false)} />
    </>
  )
}
