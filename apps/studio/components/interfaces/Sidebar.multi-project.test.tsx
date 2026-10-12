import { screen } from '@testing-library/react'
import { SidebarProvider } from 'ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarContent } from './Sidebar'
import { OrgMenuContent } from '@/components/layouts/ProjectLayout/LayoutHeader/MobileMenuContent/OrgMenuContent'
import { createMockOrganization, render } from '@/tests/helpers'

/**
 * Fork: on a multi-project platform (`NEXT_PUBLIC_IS_MULTI_PROJECT`) the organization menus keep
 * only Projects; Team, Integrations, Usage, Billing and Organization settings read platform routes
 * self-hosted Studio does not serve (deploy/platform/SPEC.md §16). Without the flag, unchanged.
 */

const flags = vi.hoisted(() => ({ multiProject: false }))

vi.mock('@/lib/constants/multi-project', () => ({
  get IS_MULTI_PROJECT() {
    return flags.multiProject
  },
}))

vi.mock('common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('common')>()),
  useParams: () => ({ slug: 'default-org-slug' }),
  useIsMFAEnabled: () => false,
}))

vi.mock('next/router', () => ({
  useRouter: () => ({
    pathname: '/org/[slug]',
    asPath: '/org/default-org-slug',
    query: { slug: 'default-org-slug' },
    push: vi.fn(),
  }),
}))

vi.mock('@/hooks/misc/useSelectedOrganization', () => ({
  useSelectedOrganizationQuery: () => ({
    data: createMockOrganization({ slug: 'default-org-slug' }),
  }),
}))

vi.mock('@/hooks/misc/useIsFeatureEnabled', () => ({
  useIsFeatureEnabled: () => true,
}))

const ALL = ['Projects', 'Team', 'Integrations', 'Usage', 'Billing']

const linkNames = () => screen.getAllByRole('link').map((link) => link.textContent?.trim())

describe('organization menus', () => {
  beforeEach(() => {
    flags.multiProject = false
  })

  it('keep every upstream link without the flag', () => {
    render(
      <SidebarProvider>
        <SidebarContent />
      </SidebarProvider>
    )
    for (const name of ALL) expect(linkNames()).toContain(name)
  })

  it('show only Projects in the sidebar under the flag', () => {
    flags.multiProject = true
    render(
      <SidebarProvider>
        <SidebarContent />
      </SidebarProvider>
    )
    expect(linkNames()).toEqual(['Projects'])
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'href',
      '/org/default-org-slug'
    )
  })

  it('show only Projects in the mobile menu under the flag, and all without it', () => {
    const { unmount } = render(
      <SidebarProvider>
        <OrgMenuContent />
      </SidebarProvider>
    )
    for (const name of ALL) expect(screen.getByText(name)).toBeInTheDocument()
    unmount()

    flags.multiProject = true
    render(
      <SidebarProvider>
        <OrgMenuContent />
      </SidebarProvider>
    )
    expect(screen.getByText('Projects')).toBeInTheDocument()
    for (const name of ALL.slice(1)) expect(screen.queryByText(name)).not.toBeInTheDocument()
    expect(screen.queryByText('Organization settings')).not.toBeInTheDocument()
  })
})
