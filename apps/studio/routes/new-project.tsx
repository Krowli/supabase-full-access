import { createFileRoute } from '@tanstack/react-router'

import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import WizardLayout from '@/components/layouts/WizardLayout'
import NewProjectPage from '@/pages/new-project'

export const Route = createFileRoute('/new-project')({
  component: NewProjectRoute,
})

// Fork: the TanStack mirror of `pages/new-project.tsx`, laid out like `routes/new/$slug.tsx`.
function NewProjectRoute() {
  return (
    <DefaultLayout hideMobileMenu headerTitle="New project">
      <WizardLayout>
        <NewProjectPage dehydratedState={undefined} />
      </WizardLayout>
    </DefaultLayout>
  )
}
