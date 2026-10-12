import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle, Button, CriticalIcon } from 'ui'
import {
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'

import { MultiProjectDeleteDialog } from './MultiProjectDeleteDialog'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'

/**
 * Fork: Settings → General → "Delete project" on a multi-project Studio (deploy/platform/SPEC.md
 * M6), laid out like upstream's panel. `default` is the Studio's own stack, which the control plane
 * does not own, so it has no such panel.
 */
export const MultiProjectDeletePanel = () => {
  const { data: project } = useSelectedProjectQuery()
  const [isOpen, setIsOpen] = useState(false)

  if (project === undefined || project.ref === 'default') return null

  return (
    <PageSection id="delete-project">
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle>Delete project</PageSectionTitle>
          <PageSectionDescription>
            Permanently remove your project and its database
          </PageSectionDescription>
        </PageSectionSummary>
      </PageSectionMeta>

      <PageSectionContent>
        <Alert variant="destructive">
          <CriticalIcon />
          <AlertTitle>Deleting this project will also remove your database.</AlertTitle>
          <AlertDescription>
            Make sure you have made a backup if you want to keep your data.
          </AlertDescription>
          <div className="mt-2">
            <Button variant="danger" onClick={() => setIsOpen(true)}>
              Delete project
            </Button>
          </div>
        </Alert>
      </PageSectionContent>
      <MultiProjectDeleteDialog visible={isOpen} onClose={() => setIsOpen(false)} />
    </PageSection>
  )
}
