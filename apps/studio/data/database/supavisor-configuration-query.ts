import { useQuery } from '@tanstack/react-query'

import { databaseKeys } from './keys'
import { get, handleError } from '@/data/fetchers'
import type { StudioError } from '@/lib/errors/studio-errors'
import type { UseCustomQueryOptions } from '@/types'

type SupavisorConfigurationVariables = {
  projectRef?: string
}

export async function getSupavisorConfiguration(
  { projectRef }: SupavisorConfigurationVariables,
  signal?: AbortSignal
) {
  if (!projectRef) throw new Error('Project ref is required')

  const { data, error } = await get(`/platform/projects/{ref}/config/supavisor`, {
    params: { path: { ref: projectRef } },
    signal,
  })
  if (error) handleError(error)
  return data
}

export type SupavisorConfigurationData = Awaited<ReturnType<typeof getSupavisorConfiguration>>
export type SupavisorConfigurationError = StudioError

export const useSupavisorConfigurationQuery = <TData = SupavisorConfigurationData>(
  { projectRef }: SupavisorConfigurationVariables,
  {
    enabled = true,
    ...options
  }: UseCustomQueryOptions<SupavisorConfigurationData, SupavisorConfigurationError, TData> = {}
) =>
  useQuery<SupavisorConfigurationData, SupavisorConfigurationError, TData>({
    queryKey: databaseKeys.poolingConfiguration(projectRef),
    queryFn: ({ signal }) => getSupavisorConfiguration({ projectRef }, signal),
    // No `IS_PLATFORM` gate: self-hosted this endpoint is served by
    // `pages/api/platform/projects/[ref]/config/supavisor.ts`, which describes the single pooler
    // this stack runs.
    enabled: enabled && typeof projectRef !== 'undefined',
    ...options,
  })
