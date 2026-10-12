import { useRouter } from 'next/router'
import { useEffect } from 'react'

/**
 * Fork: sends upstream's `/new/<slug>` to the multi-project Studio's own `/new-project` page
 * (deploy/platform/SPEC.md M6). Every "New project" link upstream draws leads to `/new/<slug>`, so
 * this one redirect keeps upstream's form, which needs the platform, from ever showing.
 */
export const RedirectToNewProject = () => {
  const router = useRouter()

  const isAway = router.pathname !== '/new-project'
  useEffect(() => {
    if (isAway) router.replace('/new-project')
  }, [isAway, router])

  return null
}
