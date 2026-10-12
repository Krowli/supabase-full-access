import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import NewProjectPage from '@/pages/new-project'
import Wizard from '@/pages/new/[slug]'
import { customRender } from '@/tests/lib/custom-render'
import { routerMock } from '@/tests/lib/route-mock'

/**
 * Fork: which form "New project" opens (deploy/platform/SPEC.md M6). Upstream's `/new/<slug>` sends
 * a multi-project Studio to `/new-project`; without the flag nothing changes and `/new-project`
 * does not exist.
 */

const flags = vi.hoisted(() => ({ multiProject: false }))

vi.mock('@/lib/constants/multi-project', () => ({
  get IS_MULTI_PROJECT() {
    return flags.multiProject
  },
}))

vi.mock('@/components/interfaces/ProjectCreation/ProjectCreationForm', () => ({
  ProjectCreationForm: () => <div data-testid="upstream-form" />,
}))

vi.mock('@/components/interfaces/MultiProject/NewProjectForm', () => ({
  NewProjectForm: () => <div data-testid="fork-form" />,
}))

beforeEach(() => {
  flags.multiProject = false
})

describe('without the multi-project flag', () => {
  it('/new/<slug> shows upstream form', async () => {
    routerMock.setCurrentUrl('/new/default-org-slug')
    customRender(<Wizard dehydratedState={undefined} />)

    expect(screen.getByTestId('upstream-form')).toBeInTheDocument()
    expect(routerMock.asPath).toBe('/new/default-org-slug')
  })

  it('/new-project sends the visitor home', async () => {
    routerMock.setCurrentUrl('/new-project')
    customRender(<NewProjectPage dehydratedState={undefined} />)

    expect(screen.queryByTestId('fork-form')).not.toBeInTheDocument()
    await waitFor(() => expect(routerMock.asPath).toBe('/'))
  })
})

describe('with the multi-project flag', () => {
  beforeEach(() => {
    flags.multiProject = true
  })

  it('/new/<slug> goes to /new-project without drawing upstream form', async () => {
    routerMock.setCurrentUrl('/new/default-org-slug')
    customRender(<Wizard dehydratedState={undefined} />)

    expect(screen.queryByTestId('upstream-form')).not.toBeInTheDocument()
    await waitFor(() => expect(routerMock.asPath).toBe('/new-project'))
  })

  it('/new-project shows the fork form', () => {
    routerMock.setCurrentUrl('/new-project')
    customRender(<NewProjectPage dehydratedState={undefined} />)

    expect(screen.getByTestId('fork-form')).toBeInTheDocument()
    expect(routerMock.asPath).toBe('/new-project')
  })
})
