import { screen } from '@testing-library/react'
import { LOCAL_STORAGE_KEYS } from 'common'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FeaturePreviewContextProvider, useIsExplorerEnabled } from './FeaturePreviewContext'
import { useVisibleFeaturePreviewsByCategory } from './useFeaturePreviews'
import { customRender } from '@/tests/lib/custom-render'

vi.mock('@/lib/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/constants')>()),
  IS_PLATFORM: false,
}))

const Probe = () => {
  const groups = useVisibleFeaturePreviewsByCategory()
  const isExplorerEnabled = useIsExplorerEnabled()
  const names = groups.flatMap((group) => group.previews.map((preview) => preview.name))

  return (
    <>
      <p data-testid="previews">{names.join(', ')}</p>
      <p data-testid="explorer">{String(isExplorerEnabled)}</p>
    </>
  )
}

const renderProbe = () =>
  customRender(
    <FeaturePreviewContextProvider>
      <Probe />
    </FeaturePreviewContextProvider>
  )

describe('Explorer & Notebooks preview, self-hosted', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('is offered in the feature previews', () => {
    renderProbe()

    expect(screen.getByTestId('previews')).toHaveTextContent('Explorer & Notebooks')
  })

  it('stays off until it is switched on', () => {
    renderProbe()

    expect(screen.getByTestId('explorer')).toHaveTextContent('false')
  })

  it('is on once switched on', () => {
    localStorage.setItem(LOCAL_STORAGE_KEYS.UI_PREVIEW_EXPLORER, 'true')

    renderProbe()

    expect(screen.getByTestId('explorer')).toHaveTextContent('true')
  })
})
