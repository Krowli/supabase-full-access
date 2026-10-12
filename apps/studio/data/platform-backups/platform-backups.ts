import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { fetchGet, fetchPost } from '@/data/fetchers'
import { API_URL } from '@/lib/constants'
import { ResponseError } from '@/types'

/**
 * Fork: the platform's backups of one project (deploy/platform/SPEC.md §19). The routes are the
 * fork's own (`pages/api/platform/projects/[ref]/backups`), so they are not in the platform API types.
 */

export type PlatformBackupRun = {
  id: number
  ref: string
  kind: 'scheduled' | 'manual' | 'restore'
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  destination: string | null
  snapshot_id: string | null
  size_bytes: number | null
  target_ref: string | null
  error: string | null
  warnings: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
}

export type PlatformBackupSnapshot = { id: string; time: string; size_bytes: number | null }

export type PlatformBackups = {
  configured: boolean
  config_error: string | null
  config_note: string | null
  /** A deleted project's backups are removed this many days later (null: backups not configured). */
  deleted_project_retention_days: number | null
  enabled: boolean
  destination: string | null
  schedule: string | null
  keep: { daily: number; weekly: number; monthly: number } | null
  snapshots: PlatformBackupSnapshot[]
  snapshots_error: string | null
  runs: PlatformBackupRun[]
}

export const platformBackupsKey = (projectRef?: string) => ['projects', projectRef, 'platform-backups']

export async function getPlatformBackups(projectRef: string, signal?: AbortSignal) {
  const response = await fetchGet<PlatformBackups>(`${API_URL}/platform/projects/${projectRef}/backups`, {
    abortSignal: signal,
  })
  if (response instanceof ResponseError) throw response
  return response
}

const isActive = (data?: PlatformBackups) =>
  data?.runs.some((r) => r.status === 'queued' || r.status === 'running') ?? false

export const usePlatformBackupsQuery = (projectRef?: string) =>
  useQuery<PlatformBackups, ResponseError>({
    queryKey: platformBackupsKey(projectRef),
    queryFn: ({ signal }) => getPlatformBackups(projectRef!, signal),
    enabled: typeof projectRef !== 'undefined',
    // Follow a backup or restore while it runs.
    refetchInterval: (query) => (isActive(query.state.data) ? 5000 : false),
  })

export const usePlatformBackupRunMutation = (projectRef?: string) => {
  const queryClient = useQueryClient()
  return useMutation<PlatformBackupRun, ResponseError, void>({
    mutationFn: async () => {
      const response = await fetchPost<PlatformBackupRun>(`${API_URL}/platform/projects/${projectRef}/backups`, {})
      if (response instanceof ResponseError) throw response
      return response
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: platformBackupsKey(projectRef) }),
  })
}

export const usePlatformBackupRestoreMutation = (projectRef?: string) => {
  const queryClient = useQueryClient()
  return useMutation<PlatformBackupRun, ResponseError, { snapshotId: string; name: string }>({
    mutationFn: async ({ snapshotId, name }) => {
      const response = await fetchPost<PlatformBackupRun>(
        `${API_URL}/platform/projects/${projectRef}/backups/restore`,
        { snapshot_id: snapshotId, name }
      )
      if (response instanceof ResponseError) throw response
      return response
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: platformBackupsKey(projectRef) }),
  })
}
