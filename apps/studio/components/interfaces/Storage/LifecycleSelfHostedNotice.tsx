import { Admonition } from 'ui-patterns/Admonition'

import { IS_PLATFORM } from '@/lib/constants'

/**
 * Fork: self-hosted storage-api stores lifecycle rules but nothing in it applies them (FORK.md,
 * object versioning), so wherever rules are set the dashboard says so.
 */
export const LifecycleSelfHostedNotice = ({ className }: { className?: string }) =>
  IS_PLATFORM ? null : (
    <Admonition
      type="default"
      className={className}
      title="Lifecycle rules are saved but not applied"
      description="Self-hosted Storage keeps every noncurrent version. Delete old versions from a file's version history."
    />
  )
