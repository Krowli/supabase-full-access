import { useRouter } from 'next/router'
import { toast } from 'sonner'

import { TextConfirmModal } from '@/components/ui/TextConfirmModalWrapper'
import { usePlatformBackupsQuery } from '@/data/platform-backups/platform-backups'
import { useProjectDeleteMutation } from '@/data/projects/project-delete-mutation'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'

/**
 * Fork: confirms deleting the selected project on a multi-project Studio (deploy/platform/SPEC.md
 * M6). Upstream's dialog asks for a cancellation survey and posts it to the platform, which
 * self-hosted has no plan or feedback API for; this keeps only its typed-name confirmation. The
 * control plane removes the project's stack, tenants, gateway routes and bucket before it answers.
 */
export const MultiProjectDeleteDialog = ({
  visible,
  onClose,
}: {
  visible: boolean
  onClose: () => void
}) => {
  const router = useRouter()
  const { data: project } = useSelectedProjectQuery()
  const { data: organization } = useSelectedOrganizationQuery()

  // How long the platform keeps this project's backups once it is gone (SPEC.md §19).
  const { data: backups } = usePlatformBackupsQuery(visible ? project?.ref : undefined)
  const retentionDays =
    backups?.configured && backups.enabled ? backups.deleted_project_retention_days : null
  const backupsNote =
    retentionDays === null || retentionDays === undefined
      ? ''
      : retentionDays === 0
        ? ' Its backups are deleted with it.'
        : ` Backups of this project are kept for ${retentionDays} days, then deleted.`

  const { mutate: deleteProject, isPending } = useProjectDeleteMutation({
    onSuccess: () => {
      toast.success(`Successfully deleted ${project?.name}`)
      router.push('/project/default')
    },
  })

  return (
    <TextConfirmModal
      visible={visible}
      loading={isPending}
      size="medium"
      variant="destructive"
      title={`Confirm deletion of ${project?.name}`}
      alert={{ title: 'This action cannot be undone.' }}
      text={`This will permanently delete the ${project?.name} project and all of its data: its database, its users and its storage files.${backupsNote}`}
      confirmPlaceholder="Type the project name in here"
      confirmString={project?.name ?? ''}
      confirmLabel="I understand, delete this project"
      onConfirm={() => {
        if (project)
          deleteProject({ projectRef: project.ref, organizationSlug: organization?.slug })
      }}
      onCancel={() => {
        if (!isPending) onClose()
      }}
    />
  )
}
