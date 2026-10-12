import type { NextApiResponse } from 'next'

import { controlPlaneConfig, currentProjectRef, DEFAULT_PROJECT_REF } from './project-context'

/**
 * Fork: Database → Backups on a multi-project Studio (deploy/platform/SPEC.md §19). The platform's
 * backup service (`STUDIO_BACKUP_URL`, the control plane's token) does the work; these routes pass
 * the request on for the project the route names. Errors are `{ message }`, as in
 * `project-lifecycle.ts`.
 */

export type BackupAction =
  | { action: 'view' }
  | { action: 'run' }
  | { action: 'restore'; body: Record<string, unknown> }

export async function forwardBackupRequest(
  config: { url: string; token: string },
  ref: string,
  request: BackupAction
): Promise<{ status: number; body: unknown }> {
  const base = `${config.url.replace(/\/+$/, '')}/projects/${encodeURIComponent(ref)}`
  const url = request.action === 'view' ? base : `${base}/${request.action === 'run' ? 'backups' : 'restore'}`
  const body =
    request.action === 'restore'
      ? JSON.stringify({ snapshot_id: request.body.snapshot_id, name: request.body.name })
      : undefined
  try {
    const res = await fetch(url, {
      method: request.action === 'view' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(60_000),
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, body: json }
  } catch {
    return { status: 502, body: { message: 'The backup service did not answer' } }
  }
}

export async function handleProjectBackups(
  res: NextApiResponse,
  request: BackupAction
): Promise<void> {
  const url = process.env.STUDIO_BACKUP_URL
  const registry = controlPlaneConfig()
  if (!url || !registry) {
    return res
      .status(501)
      .json({ message: 'Backups need the platform backup service (STUDIO_BACKUP_URL)' })
  }
  const ref = currentProjectRef()
  if (ref === DEFAULT_PROJECT_REF) {
    return res.status(400).json({ message: 'Project default has no backups' })
  }
  const { status, body } = await forwardBackupRequest({ url, token: registry.token }, ref, request)
  return res.status(status).json(body)
}
