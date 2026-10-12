import { Admonition } from 'ui-patterns/Admonition'

import { IS_PLATFORM } from '@/lib/constants'
import { IS_MULTI_PROJECT } from '@/lib/constants/multi-project'

/**
 * Self-hosted storage-api reads its settings at start-up. On a multi-project platform (fork) the
 * project's storage restarts by itself a few seconds after a save
 * (deploy/platform/project-compose.yaml); a single self-hosted stack needs a restart in Coolify.
 */
export const StorageSettingsNotice = ({ className }: { className?: string }) => {
  if (IS_PLATFORM) return null
  if (IS_MULTI_PROJECT)
    return (
      <Admonition
        className={className}
        type="default"
        title="Changes apply in a few seconds"
        description="Storage restarts by itself after a save. An upload running at that moment may need to be retried."
      />
    )
  return (
    <Admonition
      className={className}
      type="default"
      title="Changes apply after a restart"
      description="Self-hosted storage reads these settings at start-up. After saving, restart the supabase-storage service in Coolify."
    />
  )
}
