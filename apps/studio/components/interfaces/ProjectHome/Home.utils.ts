export const DEFAULT_SECTION_ORDER = ['connect', 'usage', 'advisor', 'custom-report']

/**
 * Reconciles a stored section order with the canonical list.
 * Preserves user ordering for known sections, inserts missing
 * sections at their default-relative position.
 */
export function mergeSectionOrder(stored: string[]): string[] {
  const known = stored.filter((id) => DEFAULT_SECTION_ORDER.includes(id))
  const missing = DEFAULT_SECTION_ORDER.filter((id) => !known.includes(id))

  if (missing.length === 0 && known.length === stored.length) return stored

  const merged = [...known]
  for (const id of missing) {
    const defaultIndex = DEFAULT_SECTION_ORDER.indexOf(id)
    const nextKnown = DEFAULT_SECTION_ORDER.slice(defaultIndex + 1).find((c) => merged.includes(c))

    if (!nextKnown) {
      merged.push(id)
    } else {
      merged.splice(merged.indexOf(nextKnown), 0, id)
    }
  }
  return merged
}

/** Whether a home section renders at all. */
export function isHomeSectionVisible(
  id: string,
  {
    isPlatform,
    isExplorerEnabled,
    showConnectSection,
  }: { isPlatform: boolean; isExplorerEnabled: boolean; showConnectSection: boolean }
): boolean {
  if (id === 'connect') return showConnectSection
  if (id === 'usage') return isPlatform
  // Under the Explorer preview this slot holds Notebooks, which self-hosted keeps too
  // (lib/api/self-hosted/notebooks.ts); custom reports themselves stay platform-only.
  if (id === 'custom-report') return isPlatform || isExplorerEnabled
  return true
}
