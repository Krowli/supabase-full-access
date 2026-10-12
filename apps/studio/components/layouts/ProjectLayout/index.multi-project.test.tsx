import { render, screen } from '@testing-library/react'
import { type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MobileSheetProvider } from '../Navigation/NavigationBar/MobileSheetContext'
import { ProjectLayout } from './index'
import type { MobileMenuContentProps } from './LayoutHeader/MobileMenuContent'

/**
 * Fork: a multi-project Studio shows the building and failed screens on every page that needs the
 * database, the project home included (deploy/platform/SPEC.md M6). Without the flag, the layout
 * draws what upstream draws. The mocks are those of `index.test.tsx`.
 */

const flags = vi.hoisted(() => ({ multiProject: false }))

vi.mock('@/lib/constants/multi-project', () => ({
  get IS_MULTI_PROJECT() {
    return flags.multiProject
  },
}))

vi.mock('@/components/interfaces/MultiProject/ProvisioningState', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/components/interfaces/MultiProject/ProvisioningState')
  >()),
  ProvisioningState: ({ status }: { status?: string }) => (
    <div data-testid="provisioning-state">{status}</div>
  ),
}))

const { mockRouter, mockSetSelectedDatabaseId, mockSetMobileMenuOpen } = vi.hoisted(() => ({
  mockRouter: {
    pathname: '/project/[ref]/observability/query-performance',
    asPath: '/project/default/observability/query-performance',
    push: vi.fn(),
    replace: vi.fn(),
  },
  mockSetSelectedDatabaseId: vi.fn(),
  mockSetMobileMenuOpen: vi.fn(),
}))

const {
  mockAddBanner,
  mockDismissBanner,
  mockProjectState,
  mockResourceWarningsState,
  mockUseLocalStorageQuery,
} = vi.hoisted(() => ({
  mockAddBanner: vi.fn(),
  mockDismissBanner: vi.fn(),
  mockProjectState: {
    current: {
      ref: 'default',
      name: 'Project 1',
      status: 'ACTIVE_HEALTHY',
      postgrestStatus: 'ONLINE',
      infra_compute_size: undefined as string | undefined,
      integration_source: null as string | null,
    },
  },
  mockResourceWarningsState: { current: undefined as any[] | undefined },
  mockUseLocalStorageQuery: vi.fn(),
}))

vi.mock('next/router', () => ({
  useRouter: () => mockRouter,
}))

vi.mock('next/head', async () => {
  const React = await import('react')

  const Head = ({ children }: { children?: ReactNode }) => {
    React.useEffect(() => {
      const titleElement = React.Children.toArray(children).find(
        (child) => React.isValidElement(child) && child.type === 'title'
      )

      if (!React.isValidElement<{ children: ReactNode }>(titleElement)) return

      const titleText = React.Children.toArray(titleElement.props.children).join('')
      document.title = titleText
    }, [children])

    return null
  }

  return { default: Head }
})

vi.mock('common', () => ({
  useParams: () => ({ ref: 'default' }),
  mergeRefs:
    (..._refs: any[]) =>
    (_value: unknown) => {},
  IS_PLATFORM: false,
  LOCAL_STORAGE_KEYS: {
    FREE_MICRO_UPGRADE_BANNER_DISMISSED: (ref: string) =>
      `free-micro-upgrade-banner-dismissed-${ref}`,
    PROJECT_INTEGRATION_BANNER_DISMISSED: (ref: string, integrationSource: string) =>
      `project-integration-banner-dismissed-${ref}-${integrationSource}`,
  },
  isFeatureEnabled: () => false,
  useFlag: () => false,
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    create: (Component: any) => Component,
  },
}))

vi.mock('ui', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  Alert: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  AlertDescription: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  AlertTitle: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CommandInput: { displayName: 'CommandInput' },
  Command: { displayName: 'Command' },
  CommandGroup: { displayName: 'CommandGroup' },
  CommandItem: { displayName: 'CommandItem' },
  CommandList: { displayName: 'CommandList' },
  LogoLoader: () => <div data-testid="logo-loader" />,
  ResizableHandle: (props: any) => <div {...props} />,
  ResizablePanel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  ResizablePanelGroup: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Sidebar: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SidebarContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SidebarFooter: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SidebarGroup: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SidebarMenu: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SidebarMenuButton: (props: any) => <div {...props} />,
  SidebarMenuItem: (props: any) => <div {...props} />,
  useIsMobile: () => false,
  usePanelRef: () => undefined,
  useSidebar: () => ({ setOpen: vi.fn() }),
}))

vi.mock('ui-patterns/MobileSheetNav/MobileSheetNav', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('../editors/EditorsLayout.hooks', () => ({
  useEditorType: () => undefined,
}))

vi.mock('../MainScrollContainerContext', () => ({
  useMainScrollContainer: () => null,
  useSetMainScrollContainer: () => () => {},
}))

vi.mock('./BuildingState', () => ({ default: () => null }))
vi.mock('./ConnectingState', () => ({ default: () => null }))
vi.mock('./LoadingState', () => ({ LoadingState: () => null }))
vi.mock('./PausedState/ProjectPausedState', () => ({ ProjectPausedState: () => null }))
vi.mock('./PauseFailedState', () => ({ PauseFailedState: () => null }))
vi.mock('./PausingState', () => ({ PausingState: () => null }))
vi.mock('./ProductMenuBar', () => ({
  ProductMenuBar: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('./ResizingState', () => ({ ResizingState: () => null }))
vi.mock('./RestartingState', () => ({ default: () => null }))
vi.mock('./RestoreFailedState', () => ({ RestoreFailedState: () => null }))
vi.mock('./RestoringState', () => ({ RestoringState: () => null }))
vi.mock('./UpgradingState', () => ({ UpgradingState: () => null }))

vi.mock('@/components/interfaces/BranchManagement/CreateBranchModal', () => ({
  CreateBranchModal: () => null,
}))
vi.mock('@/components/interfaces/ProjectAPIDocs/ProjectAPIDocs', () => ({
  ProjectAPIDocs: () => null,
}))
vi.mock('@/components/ui/ResourceExhaustionWarningBanner/ResourceExhaustionWarningBanner', () => ({
  ResourceExhaustionWarningBanner: () => null,
}))
vi.mock('@/components/ui/ButtonTooltip', () => ({
  ButtonTooltip: ({ children, ...props }: any) => (
    <button tabIndex={0} {...props}>
      {children}
    </button>
  ),
}))
vi.mock('@/components/ui/PartnerIcon', () => ({
  default: () => <div data-testid="partner-icon" />,
}))

vi.mock('@/hooks/custom-content/useCustomContent', () => ({
  useCustomContent: () => ({ appTitle: 'Supabase' }),
}))

vi.mock('@/hooks/misc/useLocalStorage', () => ({
  useLocalStorageQuery: (...args: unknown[]) => mockUseLocalStorageQuery(...args),
}))

vi.mock('@/components/ui/BannerStack/BannerStackProvider', () => ({
  BANNER_ID: {
    FREE_MICRO_UPGRADE: 'free-micro-upgrade-banner',
    SELECT_26: 'select-2026-banner',
  },
  useBannerStack: () => ({
    addBanner: mockAddBanner,
    dismissBanner: mockDismissBanner,
    banners: [],
  }),
}))

vi.mock('@/components/ui/BannerStack/Banners/BannerFreeMicroUpgrade', () => ({
  BannerFreeMicroUpgrade: () => null,
}))

vi.mock('@/data/usage/resource-warnings-query', () => ({
  useResourceWarningsQuery: () => ({ data: mockResourceWarningsState.current }),
}))

vi.mock('@/hooks/misc/useSelectedOrganization', () => ({
  useSelectedOrganizationQuery: () => ({
    data: { name: 'Organization 1', slug: 'org-1' },
  }),
}))

vi.mock('@/hooks/misc/useSelectedProject', () => ({
  useSelectedProjectQuery: () => ({ data: mockProjectState.current }),
}))

vi.mock('@/hooks/misc/withAuth', () => ({
  withAuth: (Component: any) => Component,
}))

vi.mock('@/hooks/ui/useFlag', () => ({
  usePHFlag: () => undefined,
}))

vi.mock('@/state/app-state', () => ({
  useAppStateSnapshot: () => ({
    mobileMenuOpen: false,
    showSidebar: false,
    setMobileMenuOpen: mockSetMobileMenuOpen,
  }),
}))

vi.mock('@/state/database-selector', () => ({
  useDatabaseSelectorStateSnapshot: () => ({
    setSelectedDatabaseId: mockSetSelectedDatabaseId,
  }),
}))

vi.mock('./LayoutHeader/MobileMenuContent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./LayoutHeader/MobileMenuContent')>()
  return {
    ...actual,
    MobileMenuContent: ({
      currentProductMenuHeader,
      currentProductMenu,
    }: MobileMenuContentProps) => (
      <div>
        {currentProductMenuHeader}
        {currentProductMenu}
      </div>
    ),
  }
})

vi.mock('../Navigation/ProductMenuBar', () => ({
  ProductMenuBar: () => null,
}))

const renderPage = (pathname: string, status: string) => {
  mockRouter.pathname = pathname
  mockRouter.asPath = pathname.replace('[ref]', 'default')
  mockProjectState.current = { ...mockProjectState.current, status }
  return render(
    <MobileSheetProvider>
      <ProjectLayout product="Database">
        <div data-testid="page" />
      </ProjectLayout>
    </MobileSheetProvider>
  )
}

const HOME = '/project/[ref]'
const EDITOR = '/project/[ref]/editor'
const SETTINGS = '/project/[ref]/settings/general'

beforeEach(() => {
  flags.multiProject = false
  mockRouter.replace.mockClear()
  mockResourceWarningsState.current = undefined
  mockUseLocalStorageQuery.mockImplementation(() => [false, vi.fn(), { isSuccess: true }])
  mockProjectState.current = {
    ref: 'default',
    name: 'Project 1',
    status: 'ACTIVE_HEALTHY',
    postgrestStatus: 'ONLINE',
    infra_compute_size: undefined,
    integration_source: null,
  }
})

describe('ProjectLayout with the multi-project flag', () => {
  beforeEach(() => {
    flags.multiProject = true
  })

  it.each([
    [HOME, 'COMING_UP'],
    [HOME, 'INIT_FAILED'],
    [EDITOR, 'INIT_FAILED'],
    [EDITOR, 'UNKNOWN'],
  ])('shows provisioning on %s while the project is %s', (pathname, status) => {
    renderPage(pathname, status)

    expect(screen.getByTestId('provisioning-state')).toHaveTextContent(status)
    expect(screen.queryByTestId('page')).not.toBeInTheDocument()
  })

  it('keeps settings reachable for a failed project, so it can be deleted', () => {
    renderPage(SETTINGS, 'INIT_FAILED')

    expect(screen.getByTestId('page')).toBeInTheDocument()
    expect(screen.queryByTestId('provisioning-state')).not.toBeInTheDocument()
  })

  it.each([HOME, EDITOR, SETTINGS])(
    'sends default without a stack (REMOVED) to the project list from %s',
    (pathname) => {
      renderPage(pathname, 'REMOVED')

      expect(mockRouter.replace).toHaveBeenCalledWith('/org/default-org-slug')
      expect(screen.queryByTestId('page')).not.toBeInTheDocument()
    }
  )

  it('shows a project being deleted on its database pages', () => {
    renderPage(EDITOR, 'GOING_DOWN')

    expect(screen.getByTestId('provisioning-state')).toHaveTextContent('GOING_DOWN')
  })

  it('shows the page once the project is running', () => {
    renderPage(HOME, 'ACTIVE_HEALTHY')

    expect(screen.getByTestId('page')).toBeInTheDocument()
    expect(screen.queryByTestId('provisioning-state')).not.toBeInTheDocument()
  })
})

describe('ProjectLayout without the flag', () => {
  it.each([
    [HOME, 'COMING_UP'],
    [HOME, 'INIT_FAILED'],
    [EDITOR, 'INIT_FAILED'],
  ])('draws %s for a %s project as upstream does', (pathname, status) => {
    renderPage(pathname, status)

    expect(screen.getByTestId('page')).toBeInTheDocument()
    expect(screen.queryByTestId('provisioning-state')).not.toBeInTheDocument()
  })

  it('leaves a REMOVED default where upstream puts it', () => {
    renderPage(HOME, 'REMOVED')

    expect(mockRouter.replace).not.toHaveBeenCalledWith('/org/default-org-slug')
  })
})
