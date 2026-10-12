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

beforeEach(() => {
  project.current = { ref: 'shopshopshopshopshop', name: 'Shop' }
})

describe('MultiProjectDeletePanel', () => {
  it('offers to delete a control-plane project, behind its typed name', async () => {
    customRender(<MultiProjectDeletePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))

    expect(await screen.findByText('Confirm deletion of Shop')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Type the project name in here')).toBeInTheDocument()
  })

  it('has nothing to offer for default, which the control plane does not own', () => {
    project.current = { ref: 'default', name: 'Default Project' }
    customRender(<MultiProjectDeletePanel />)

    expect(screen.queryByRole('button', { name: 'Delete project' })).not.toBeInTheDocument()
  })
})
