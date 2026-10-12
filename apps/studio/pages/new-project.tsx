import Head from 'next/head'
import { useRouter } from 'next/router'
import { PropsWithChildren, useEffect } from 'react'

import { NewProjectForm } from '@/components/interfaces/MultiProject/NewProjectForm'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { WizardLayoutWithoutAuth } from '@/components/layouts/WizardLayout'
import { useCustomContent } from '@/hooks/custom-content/useCustomContent'
import { withAuth } from '@/hooks/misc/withAuth'
import { IS_MULTI_PROJECT } from '@/lib/constants/multi-project'
import { buildStudioPageTitle } from '@/lib/page-title'
import type { NextPageWithLayout } from '@/types'

/**
 * Fork: "New project" on a multi-project self-hosted Studio (deploy/platform/SPEC.md M6). Laid out
 * like upstream's `/new/[slug]`. Without `NEXT_PUBLIC_IS_MULTI_PROJECT` the page does not exist:
 * it sends the visitor home.
 */
const NewProjectPage: NextPageWithLayout = () => {
  const router = useRouter()
  const { appTitle } = useCustomContent(['app:title'])

  const isOff = !IS_MULTI_PROJECT && router.pathname === '/new-project'
  useEffect(() => {
    if (isOff) router.replace('/')
  }, [isOff, router])

  if (!IS_MULTI_PROJECT) return null

  return (
    <>
      <Head>
        <title>
          {buildStudioPageTitle({ section: 'New Project', brand: appTitle || 'Supabase' })}
        </title>
      </Head>
      <NewProjectForm />
    </>
  )
}

const PageLayout = withAuth(({ children }: PropsWithChildren) => {
  return <WizardLayoutWithoutAuth>{children}</WizardLayoutWithoutAuth>
})

NewProjectPage.getLayout = (page) => (
  <DefaultLayout hideMobileMenu headerTitle="New project">
    <PageLayout>{page}</PageLayout>
  </DefaultLayout>
)

export default NewProjectPage
