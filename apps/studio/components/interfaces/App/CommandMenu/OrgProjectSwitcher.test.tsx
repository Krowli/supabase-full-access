import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectSwitchCommand } from './OrgProjectSwitcher'

/**
 * Fork: the command menu's "Switch project" on a self-hosted Studio built with
 * `NEXT_PUBLIC_IS_MULTI_PROJECT` (deploy/platform/SPEC.md M2).
 */

const flags = vi.hoisted(() => ({ multiProject: false }))
const { useProjectsInfiniteQuery, useRegisterCommands } = vi.hoisted(() => ({
  useProjectsInfiniteQuery: vi.fn(),
  useRegisterCommands: vi.fn(),
}))

vi.mock('common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('common')>()),
  IS_PLATFORM: false,
}))

vi.mock('@/lib/constants/multi-project', () => ({
  get IS_MULTI_PROJECT() {
    return flags.multiProject
  },
}))

vi.mock('@/data/projects/projects-infinite-query', () => ({ useProjectsInfiniteQuery }))

vi.mock('ui-patterns/CommandMenu', () => ({
  PageType: { Commands: 'commands' },
  useRegisterCommands,
  useRegisterPage: vi.fn(),
  useSetPage: () => vi.fn(),
}))

describe('useProjectSwitchCommand, self-hosted', () => {
  beforeEach(() => {
    flags.multiProject = false
    useProjectsInfiniteQuery.mockReset()
    useRegisterCommands.mockReset()
  })

  it('does not ask for projects without the multi-project flag', () => {
    useProjectsInfiniteQuery.mockReturnValue({ data: undefined })
    renderHook(() => useProjectSwitchCommand())

    expect(useProjectsInfiniteQuery).toHaveBeenCalledWith({}, { enabled: false })
  })

  it('offers to switch between the registry projects with the flag', () => {
    flags.multiProject = true
    useProjectsInfiniteQuery.mockReturnValue({
      data: {
        pages: [
          {
            projects: [
              { ref: 'default', name: 'Default Project' },
              { ref: 'alpha', name: 'Alpha shop' },
            ],
          },
        ],
      },
    })
    renderHook(() => useProjectSwitchCommand())

    expect(useProjectsInfiniteQuery).toHaveBeenCalledWith({}, { enabled: true })
    expect(useRegisterCommands).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ id: 'switch-project' })],
      { enabled: true }
    )
  })
})
