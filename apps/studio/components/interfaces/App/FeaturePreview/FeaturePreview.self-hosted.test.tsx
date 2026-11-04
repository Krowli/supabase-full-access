import { screen, waitFor } from '@testing-library/react'
import { LOCAL_STORAGE_KEYS } from 'common'
import { HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FeaturePreviewContextProvider,
  useIsExplorerEnabled,
  useIsStorageVersioningEnabled,
} from './FeaturePreviewContext'
import { useVisibleFeaturePreviewsByCategory } from './useFeaturePreviews'
import { customRender } from '@/tests/lib/custom-render'
import { addAPIMock } from '@/tests/lib/msw'

vi.mock('@/lib/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/constants')>()),
  IS_PLATFORM: false,
}))

vi.mock('common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('common')>()),
  useParams: () => ({ ref: 'default' }),
}))

const Probe = () => {
  const groups = useVisibleFeaturePreviewsByCategory()
  const isExplorerEnabled = useIsExplorerEnabled()
  const isStorageVersioningEnabled = useIsStorageVersioningEnabled()
  const names = groups.flatMap((group) => group.previews.map((preview) => preview.name))

  return (
    <>
      <p data-testid="previews">{names.join(', ')}</p>
      <p data-testid="explorer">{String(isExplorerEnabled)}</p>
      <p data-testid="versioning">{String(isStorageVersioningEnabled)}</p>
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

/** The project's storage config, as the fork's handler answers it (service-config/storage.ts). */
const withObjectVersioning = (available: boolean) =>
  addAPIMock({
    method: 'get',
    path: '/platform/projects/:ref/config/storage',
    // @ts-expect-error only the field the versioning gate reads
    response: () =>
      HttpResponse.json({
        capabilities: { iceberg_catalog: false, list_v2: false, object_versioning: available },
      }),
  })

describe('Storage object versioning preview, self-hosted', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('is offered in the feature previews', () => {
    withObjectVersioning(true)
    renderProbe()

    expect(screen.getByTestId('previews')).toHaveTextContent('Storage object versioning')
  })

  it('stays off until it is switched on', async () => {
    withObjectVersioning(true)
    renderProbe()

    await waitFor(() => expect(screen.getByTestId('versioning')).toHaveTextContent('false'))
  })

  it("is on once switched on, where the project's storage-api has versioning", async () => {
    withObjectVersioning(true)
    localStorage.setItem(LOCAL_STORAGE_KEYS.UI_PREVIEW_STORAGE_VERSIONING, 'true')

    renderProbe()

    await waitFor(() => expect(screen.getByTestId('versioning')).toHaveTextContent('true'))
  })

  it("stays off where the project's storage-api has no versioning", async () => {
    withObjectVersioning(false)
    localStorage.setItem(LOCAL_STORAGE_KEYS.UI_PREVIEW_STORAGE_VERSIONING, 'true')

    renderProbe()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByTestId('versioning')).toHaveTextContent('false')
  })
})
