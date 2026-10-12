import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { projectKeys } from './keys'
import { useInvalidateProjectsInfiniteQuery } from './org-projects-infinite-query'
import type { Project } from './project-detail-query'
import { fetchPost } from '@/data/fetchers'
import { API_URL } from '@/lib/constants'
import { ResponseError, type UseCustomMutationOptions } from '@/types'

/**
 * Fork: re-runs provisioning of a project whose setup failed, through the control plane
 * (deploy/platform/SPEC.md M6). The route is the fork's own, so it is not in the platform API types.
 */

export type ProjectRetryVariables = { projectRef: string }
export type ProjectRetryData = { ref: string; status: string }

export async function retryProject({ projectRef }: ProjectRetryVariables) {
  const response = await fetchPost<ProjectRetryData>(
    `${API_URL}/platform/projects/${projectRef}/retry`,
    {}
  )
  if (response instanceof ResponseError) throw response
  return response
}

export const useProjectRetryMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<ProjectRetryData, ResponseError, ProjectRetryVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()
  const { invalidateProjectsQuery } = useInvalidateProjectsInfiniteQuery()

  return useMutation<ProjectRetryData, ResponseError, ProjectRetryVariables>({
    mutationFn: (vars) => retryProject(vars),
    async onSuccess(data, variables, context) {
      // The status the route answers, at once: the detail query polls from there, and the building
      // screen takes over from the failed one.
      queryClient.setQueryData<Project>(projectKeys.detail(variables.projectRef), (project) =>
        project ? { ...project, status: data.status as Project['status'] } : project
      )
      await invalidateProjectsQuery()
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to retry setting up the project: ${error.message}`)
      } else {
        onError(error, variables, context)
      }
    },
    ...options,
  })
}
