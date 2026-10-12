import { QueryClient } from '@tanstack/react-query'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isProvisioning, ProvisioningState } from './ProvisioningState'
import { projectKeys } from '@/data/projects/keys'
import { API_URL } from '@/lib/constants'
import { customRender } from '@/tests/lib/custom-render'
import { mswServer } from '@/tests/lib/msw'
import { routerMock } from '@/tests/lib/route-mock'

/**
 * Fork: the building and failed screens of a multi-project Studio (deploy/platform/SPEC.md M6).
 */

const REF = 'failedfailedfailedfa'
const project = vi.hoisted(() => ({
  current: { ref: 'failedfailedfailedfa', name: 'Shop', status: 'INIT_FAILED' },
}))

vi.mock('@/hooks/misc/useSelectedProject', () => ({
  useSelectedProjectQuery: () => ({ data: project.current }),
}))

vi.mock('@/components/layouts/ProjectLayout/BuildingState', () => ({
  default: () => <div data-testid="building-state" />,
}))

const newQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })

let calls: { method: string; path: string }[]

beforeEach(() => {
  calls = []
  project.current = { ref: REF, name: 'Shop', status: 'INIT_FAILED' }
  routerMock.setCurrentUrl(`/project/${REF}`)
  mswServer.use(
    http.post(`${API_URL}/platform/projects/:ref/retry`, ({ params }) => {
      calls.push({ method: 'POST', path: `/platform/projects/${params.ref}/retry` })
      return HttpResponse.json({ ref: params.ref, status: 'COMING_UP' }, { status: 202 })
    }),
    http.delete(`${API_URL}/platform/projects/:ref`, ({ params }) => {
      calls.push({ method: 'DELETE', path: `/platform/projects/${params.ref}` })
      return HttpResponse.json({ id: 0, ref: params.ref, name: 'Shop' })
    })
  )
})

describe('isProvisioning', () => {
  it('holds for the statuses of a project being set up or failed to', () => {
    expect(['COMING_UP', 'UNKNOWN', 'INIT_FAILED'].every(isProvisioning)).toBe(true)
    expect(['ACTIVE_HEALTHY', 'INACTIVE', 'RESTARTING', undefined].some(isProvisioning)).toBe(false)
  })
})

describe('ProvisioningState', () => {
  it('shows the building screen while the project is coming up', () => {
    customRender(<ProvisioningState status="COMING_UP" />)

    expect(screen.getByTestId('building-state')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('shows the failure with Retry and Delete project when setup failed', () => {
    customRender(<ProvisioningState status="INIT_FAILED" />)

    expect(screen.getByText('Setting up Shop failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete project' })).toBeInTheDocument()
    expect(screen.queryByTestId('building-state')).not.toBeInTheDocument()
  })

  it('retries through the local route and turns the project back to coming up', async () => {
    const queryClient = newQueryClient()
    queryClient.setQueryData(projectKeys.detail(REF), { ...project.current })
    customRender(<ProvisioningState status="INIT_FAILED" />, { queryClient })

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() =>
      expect(queryClient.getQueryData(projectKeys.detail(REF))).toMatchObject({
        status: 'COMING_UP',
      })
    )
    expect(calls).toEqual([{ method: 'POST', path: `/platform/projects/${REF}/retry` }])
  })

  it('deletes the project after its name is typed, then goes to default', async () => {
    customRender(<ProvisioningState status="INIT_FAILED" />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    const confirm = await screen.findByRole('button', { name: 'I understand, delete this project' })
    fireEvent.click(confirm)
    expect(calls).toEqual([])

    fireEvent.change(screen.getByPlaceholderText('Type the project name in here'), {
      target: { value: 'Shop' },
    })
    fireEvent.click(confirm)

    await waitFor(() => expect(routerMock.asPath).toBe('/project/default'))
    expect(calls).toEqual([{ method: 'DELETE', path: `/platform/projects/${REF}` }])
  })
})
