import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { forwardBackupRequest } from './project-backups'
import { mswServer } from '@/tests/lib/msw'

const BASE = 'http://backup.test'
const CONFIG = { url: `${BASE}/`, token: 'bk-token' }
const REF = 'aaaaaaaaaaaaaaaaaaaa'

describe('forwardBackupRequest', () => {
  it('reads the project view with the token', async () => {
    let auth = ''
    mswServer.use(
      http.get(`${BASE}/projects/${REF}`, ({ request }) => {
        auth = request.headers.get('authorization') ?? ''
        return HttpResponse.json({ configured: true, destination: 'r2-main', snapshots: [] })
      })
    )
    expect(await forwardBackupRequest(CONFIG, REF, { action: 'view' })).toEqual({
      status: 200,
      body: { configured: true, destination: 'r2-main', snapshots: [] },
    })
    expect(auth).toBe('Bearer bk-token')
  })

  it('starts a backup and a restore, passing only the snapshot and the name', async () => {
    let restoreBody: unknown
    mswServer.use(
      http.post(`${BASE}/projects/${REF}/backups`, () => HttpResponse.json({ id: 1, status: 'queued' }, { status: 202 })),
      http.post(`${BASE}/projects/${REF}/restore`, async ({ request }) => {
        restoreBody = await request.json()
        return HttpResponse.json({ id: 2, status: 'queued' }, { status: 202 })
      })
    )
    expect((await forwardBackupRequest(CONFIG, REF, { action: 'run' })).status).toBe(202)
    await forwardBackupRequest(CONFIG, REF, {
      action: 'restore',
      body: { snapshot_id: 'abcdef01', name: 'Copy', extra: 'dropped' },
    })
    expect(restoreBody).toEqual({ snapshot_id: 'abcdef01', name: 'Copy' })
  })

  it('passes the service refusals on as { message }', async () => {
    mswServer.use(
      http.post(`${BASE}/projects/${REF}/backups`, () =>
        HttpResponse.json({ message: 'Backups are not configured' }, { status: 409 })
      )
    )
    expect(await forwardBackupRequest(CONFIG, REF, { action: 'run' })).toEqual({
      status: 409,
      body: { message: 'Backups are not configured' },
    })
  })

  it('answers 502 when the service is down', async () => {
    mswServer.use(http.get(`${BASE}/projects/${REF}`, () => HttpResponse.error()))
    expect(await forwardBackupRequest(CONFIG, REF, { action: 'view' })).toEqual({
      status: 502,
      body: { message: 'The backup service did not answer' },
    })
  })
})
