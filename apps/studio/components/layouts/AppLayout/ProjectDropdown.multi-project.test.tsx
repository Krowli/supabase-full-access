import { screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectDropdown } from './ProjectDropdown'
import { createMockOrganization, render } from '@/tests/helpers'

/**
 * Fork: the header's project switcher on a self-hosted Studio built with
 * `NEXT_PUBLIC_IS_MULTI_PROJECT` (deploy/platform/SPEC.md M2). Without the flag it stays the
 * plain project name upstream shows self-hosted.
 */

const flags = vi.hoisted(() => ({ multiProject: false, projectCreation: false }))

vi.mock('@/lib/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/constants')>()),
  IS_PLATFORM: false,
}))

vi.mock('@/lib/constants/multi-project', () => ({
  get IS_MULTI_PROJECT() {
    return flags.multiProject
  },
}))

vi.mock('common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('common')>()),
  useParams: () => ({ ref: 'alpha' }),
}))

vi.mock('next/router', () => ({
  useRouter: () => ({ route: '/project/[ref]/editor', query: { ref: 'alpha' }, push: vi.fn() }),
}))

vi.mock('@/hooks/misc/useSelectedProject', () => ({
  useSelectedProjectQuery: () => ({
    data: { ref: 'alpha', name: 'Alpha shop', parentRef: 'alpha' },
    isPending: false,
  }),
}))

vi.mock('@/data/projects/project-detail-query', () => ({
  useProjectDetailQuery: () => ({ data: undefined, isPending: false }),
}))

vi.mock('@/hooks/misc/useSelectedOrganization', () => ({
  useSelectedOrganizationQuery: () => ({
    data: createMockOrganization({ slug: 'default-org-slug' }),
  }),
}))

vi.mock('@/hooks/misc/useIsFeatureEnabled', () => ({
  useIsFeatureEnabled: () => flags.projectCreation,
}))

vi.mock('@/components/ui/OrganizationProjectSelector', () => ({
  OrganizationProjectSelector: ({
    renderActions,
  }: {
    renderActions?: (
      setOpen: (value: boolean) => void,
      options?: { embedded?: boolean }
    ) => ReactNode
  }) => <div data-testid="project-selector">{renderActions?.(() => {}, { embedded: true })}</div>,
}))

describe('ProjectDropdown, self-hosted', () => {
  beforeEach(() => {
    flags.multiProject = false
    flags.projectCreation = false
  })

  it('shows the project name alone without the multi-project flag', () => {
    render(<ProjectDropdown />)

    expect(screen.getByText('Alpha shop')).toBeInTheDocument()
    expect(screen.queryByTestId('project-selector')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('offers the project switcher with the multi-project flag', () => {
    flags.multiProject = true
    render(<ProjectDropdown />)

    expect(screen.getByRole('link', { name: /Alpha shop/ })).toHaveAttribute(
      'href',
      '/project/alpha'
    )
    expect(screen.getByTestId('project-selector')).toBeInTheDocument()
  })

  it('leads "New project" to the fork form with the multi-project flag', () => {
    flags.multiProject = true
    flags.projectCreation = true
    render(<ProjectDropdown embedded />)

    expect(screen.getByRole('link', { name: 'New project' })).toHaveAttribute(
      'href',
      '/new-project'
    )
  })

  it('leaves "New project" on upstream form without the flag', () => {
    flags.projectCreation = true
    render(<ProjectDropdown embedded />)

    expect(screen.getByRole('link', { name: 'New project' })).toHaveAttribute(
      'href',
      '/new/default-org-slug'
    )
  })
})
