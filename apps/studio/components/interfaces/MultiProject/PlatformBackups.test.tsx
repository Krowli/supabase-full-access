import { fireEvent, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { formatBytes, PlatformBackups } from './PlatformBackups'
import { API_URL } from '@/lib/constants'
import { customRender } from '@/tests/lib/custom-render'
import { mswServer } from '@/tests/lib/msw'

/**
 * Fork: Database → Backups on a multi-project Studio (deploy/platform/SPEC.md §19).
 */

const REF = 'shopshopshopshopshop'

vi.mock('@/hooks/misc/useSelectedProject', () => ({
  useSelectedProjectQuery: () => ({ data: { ref: 'shopshopshopshopshop', name: 'Shop', status: 'ACTIVE_HEALTHY' } }),
}))

const VIEW = {
  configured: true,
  config_error: null,
  config_note: null,
  enabled: true,
  destination: 'r2-main',
  schedule: '02:30',
  keep: { daily: 7, weekly: 4, monthly: 6 },
  snapshots: [{ id: 'abcdef0123456789', time: '2026-10-12T02:30:00Z', size_bytes: 1536 }],
  snapshots_error: null,
  runs: [
    {
      id: 1,
      ref: REF,
      kind: 'scheduled',
      status: 'succeeded',
      destination: 'r2-main',
      snapshot_id: 'abcdef0123456789',
      size_bytes: 1536,
      target_ref: null,
      error: null,
      warnings: null,
      started_at: '2026-10-12T02:30:00Z',
      finished_at: '2026-10-12T02:31:00Z',
      created_at: '2026-10-12T02:30:00Z',
    },
  ],
}

let posts: { path: string; body: unknown }[]

beforeEach(() => {
  posts = []
  mswServer.use(
    http.get(`${API_URL}/platform/projects/:ref/backups`, () => HttpResponse.json(VIEW)),
    http.post(`${API_URL}/platform/projects/:ref/backups`, ({ params }) => {
      posts.push({ path: `/platform/projects/${params.ref}/backups`, body: null })
      return HttpResponse.json({ ...VIEW.runs[0], id: 2, kind: 'manual', status: 'queued' }, { status: 202 })
    }),
    http.post(`${API_URL}/platform/projects/:ref/backups/restore`, async ({ params, request }) => {
      posts.push({ path: `/platform/projects/${params.ref}/backups/restore`, body: await request.json() })
      return HttpResponse.json({ ...VIEW.runs[0], id: 3, kind: 'restore', status: 'queued' }, { status: 202 })
    })
  )
})

describe('PlatformBackups', () => {
  it('shows where and when backups go, and the backups, without any key', async () => {
    customRender(<PlatformBackups />)
    expect(await screen.findByText(/Every day at 02:30 UTC to/)).toBeInTheDocument()
    expect(screen.getByText('r2-main')).toBeInTheDocument()
    expect(screen.getByText(/Keeps 7 daily, 4 weekly and 6 monthly/)).toBeInTheDocument()
    expect(screen.getByText('1.5 KB')).toBeInTheDocument()
    expect(screen.getByText('Nightly backup')).toBeInTheDocument()
  })

  it('starts a backup now', async () => {
    customRender(<PlatformBackups />)
    fireEvent.click(await screen.findByRole('button', { name: 'Back up now' }))
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual([`/platform/projects/${REF}/backups`]))
  })

  it('restores a backup into a new project with the name given', async () => {
    customRender(<PlatformBackups />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore into new project' }))
    const input = await screen.findByDisplayValue('Shop (restored 2026-10-12)')
    fireEvent.change(input, { target: { value: 'Shop copy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create project and restore' }))
    await waitFor(() =>
      expect(posts).toEqual([
        {
          path: `/platform/projects/${REF}/backups/restore`,
          body: { snapshot_id: 'abcdef0123456789', name: 'Shop copy' },
        },
      ])
    )
  })

  it('says backups are off when there is no configuration', async () => {
    mswServer.use(
      http.get(`${API_URL}/platform/projects/:ref/backups`, () =>
        HttpResponse.json({
          ...VIEW,
          configured: false,
          config_error: 'No BACKUP_CONFIG: backups are off.',
          snapshots: [],
          runs: [],
        })
      )
    )
    customRender(<PlatformBackups />)
    expect(await screen.findByText('Backups are off')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back up now' })).toBeNull()
  })
})

describe('formatBytes', () => {
  it('rounds to a readable unit', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB')
    expect(formatBytes(null)).toBe('')
  })
})
