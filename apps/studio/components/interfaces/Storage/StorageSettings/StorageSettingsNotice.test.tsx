import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StorageSettingsNotice } from './StorageSettingsNotice'
import { render } from '@/tests/helpers'

/**
 * Self-hosted storage-api reads its settings at start-up. On a multi-project platform the
 * project's storage restarts by itself when Studio saves them (deploy/platform/project-compose.yaml),
 * so the notice says that instead of asking for a restart in Coolify.
 */

const flags = vi.hoisted(() => ({ platform: false, multiProject: false }))

vi.mock('@/lib/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/constants')>()),
  get IS_PLATFORM() {
    return flags.platform
  },
}))
vi.mock('@/lib/constants/multi-project', () => ({
  get IS_MULTI_PROJECT() {
    return flags.multiProject
  },
}))

beforeEach(() => {
  flags.platform = false
  flags.multiProject = false
})

describe('StorageSettingsNotice', () => {
  it('asks for a restart in Coolify on a single self-hosted stack', () => {
    render(<StorageSettingsNotice />)
    expect(screen.getByText('Changes apply after a restart')).toBeInTheDocument()
  })

  it('says the change applies by itself on a multi-project platform', () => {
    flags.multiProject = true
    render(<StorageSettingsNotice />)
    expect(screen.getByText('Changes apply in a few seconds')).toBeInTheDocument()
    expect(screen.queryByText(/restart the supabase-storage service/)).not.toBeInTheDocument()
  })

  it('shows nothing on supabase.com', () => {
    flags.platform = true
    const { container } = render(<StorageSettingsNotice />)
    expect(container).toBeEmptyDOMElement()
  })
})
