import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MultiProjectDeletePanel } from './MultiProjectDeletePanel'
import { customRender } from '@/tests/lib/custom-render'

/**
 * Fork: Settings → General → "Delete project" on a multi-project Studio (deploy/platform/SPEC.md
 * M6). The delete itself is tested with the failed screen, which opens the same dialog.
 */

const project = vi.hoisted(() => ({ current: { ref: 'shopshopshopshopshop', name: 'Shop' } }))

vi.mock('@/hooks/misc/useSelectedProject', () => ({
  useSelectedProjectQuery: () => ({ data: project.current }),
}))

const backups = vi.hoisted(() => ({
  current: undefined as
    | { configured: boolean; enabled: boolean; deleted_project_retention_days: number | null }
    | undefined,
}))
vi.mock('@/data/platform-backups/platform-backups', () => ({
  usePlatformBackupsQuery: () => ({ data: backups.current }),
}))

beforeEach(() => {
  project.current = { ref: 'shopshopshopshopshop', name: 'Shop' }
  backups.current = { configured: true, enabled: true, deleted_project_retention_days: 30 }
})

describe('MultiProjectDeletePanel', () => {
  it('offers to delete a control-plane project, behind its typed name', async () => {
    customRender(<MultiProjectDeletePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))

    expect(await screen.findByText('Confirm deletion of Shop')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Type the project name in here')).toBeInTheDocument()
  })

  it('says how long the backups of the project are kept after it is deleted', async () => {
    customRender(<MultiProjectDeletePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    expect(
      await screen.findByText(/Backups of this project are kept for 30 days, then deleted\./)
    ).toBeInTheDocument()
  })

  it('says the backups go with it when they are kept 0 days, and nothing when backups are off', async () => {
    backups.current = { configured: true, enabled: true, deleted_project_retention_days: 0 }
    const { unmount } = customRender(<MultiProjectDeletePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    expect(await screen.findByText(/Its backups are deleted with it\./)).toBeInTheDocument()
    unmount()

    backups.current = { configured: false, enabled: false, deleted_project_retention_days: null }
    customRender(<MultiProjectDeletePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    expect(await screen.findByText('Confirm deletion of Shop')).toBeInTheDocument()
    expect(screen.queryByText(/backups/i)).not.toBeInTheDocument()
  })

  it('has nothing to offer for default, which the control plane does not own', () => {
    project.current = { ref: 'default', name: 'Default Project' }
    customRender(<MultiProjectDeletePanel />)

    expect(screen.queryByRole('button', { name: 'Delete project' })).not.toBeInTheDocument()
  })
})
