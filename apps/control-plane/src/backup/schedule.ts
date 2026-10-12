// When a project's daily backup is due, and what makes the backup service unhealthy.

/** A grace period after the schedule before a missing backup counts as a problem. */
const GRACE_MS = 60 * 60 * 1000

/** Today's (UTC) moment of the "HH:MM" schedule, or the latest one at or before `now`. */
function slot(now: Date, schedule: string, dayOffset = 0): Date {
  const [h, m] = schedule.split(':').map(Number)
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, h, m))
}

function latestSlot(now: Date, schedule: string): Date {
  const today = slot(now, schedule)
  return today <= now ? today : slot(now, schedule, -1)
}

/**
 * Due once today's schedule has passed and no scheduled run has started since. A run that failed
 * is not retried before the next day; "Back up now" in Studio runs one at any time.
 */
export function isDue(now: Date, schedule: string, lastScheduledStart: Date | null): boolean {
  const today = slot(now, schedule)
  return now >= today && (lastScheduledStart === null || lastScheduledStart < today)
}

export type LastRuns = {
  lastStarted: Date | null
  lastStatus: 'running' | 'succeeded' | 'failed' | null
  lastError?: string | null
  lastSuccess: Date | null
}

export type HealthInput = { id: string; schedule: string; createdAt: Date; runs: LastRuns }

/** Empty when every project is fine; otherwise one line per problem (the /health answer). */
export function healthProblems(now: Date, items: HealthInput[]): string[] {
  const problems: string[] = []
  for (const { id, schedule, createdAt, runs } of items) {
    if (runs.lastStatus === 'failed') {
      problems.push(`${id}: last backup failed: ${runs.lastError ?? 'unknown error'}`)
    }
    const expected = latestSlot(new Date(now.getTime() - GRACE_MS), schedule)
    if (expected <= createdAt) continue
    if (runs.lastSuccess === null) problems.push(`${id}: never backed up`)
    else if (runs.lastSuccess < expected)
      problems.push(`${id}: no successful backup since ${runs.lastSuccess.toISOString()}`)
  }
  return problems
}
