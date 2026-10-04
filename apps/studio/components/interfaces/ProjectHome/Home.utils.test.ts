import { describe, expect, it } from 'vitest'

import { isHomeSectionVisible, mergeSectionOrder } from './Home.utils'

describe('mergeSectionOrder', () => {
  it('returns stored order unchanged when it matches defaults', () => {
    const stored = ['connect', 'usage', 'advisor', 'custom-report']
    expect(mergeSectionOrder(stored)).toBe(stored)
  })

  it('inserts missing sections at their default-relative position', () => {
    expect(mergeSectionOrder(['usage', 'advisor', 'custom-report'])).toEqual([
      'connect',
      'usage',
      'advisor',
      'custom-report',
    ])
  })

  it('preserves user reordering while inserting missing sections', () => {
    expect(mergeSectionOrder(['advisor', 'usage', 'custom-report'])).toEqual([
      'advisor',
      'connect',
      'usage',
      'custom-report',
    ])
  })

  it('strips unknown sections from stored order', () => {
    expect(mergeSectionOrder(['usage', 'deleted-section', 'advisor', 'custom-report'])).toEqual([
      'connect',
      'usage',
      'advisor',
      'custom-report',
    ])
  })

  it('strips legacy getting-started from stored order', () => {
    expect(
      mergeSectionOrder(['connect', 'getting-started', 'usage', 'advisor', 'custom-report'])
    ).toEqual(['connect', 'usage', 'advisor', 'custom-report'])
  })
})

describe('isHomeSectionVisible', () => {
  const selfHosted = { isPlatform: false, isExplorerEnabled: false, showConnectSection: true }
  const platform = { isPlatform: true, isExplorerEnabled: false, showConnectSection: true }

  it('shows the connect section only when asked to', () => {
    expect(isHomeSectionVisible('connect', selfHosted)).toBe(true)
    expect(isHomeSectionVisible('connect', { ...selfHosted, showConnectSection: false })).toBe(
      false
    )
  })

  it('keeps usage platform-only', () => {
    expect(isHomeSectionVisible('usage', platform)).toBe(true)
    expect(isHomeSectionVisible('usage', { ...selfHosted, isExplorerEnabled: true })).toBe(false)
  })

  it('always shows the advisor section', () => {
    expect(isHomeSectionVisible('advisor', selfHosted)).toBe(true)
  })

  it('shows the reports slot on the platform', () => {
    expect(isHomeSectionVisible('custom-report', platform)).toBe(true)
  })

  it('shows the reports slot self-hosted only once Explorer is on, where it holds Notebooks', () => {
    expect(isHomeSectionVisible('custom-report', selfHosted)).toBe(false)
    expect(isHomeSectionVisible('custom-report', { ...selfHosted, isExplorerEnabled: true })).toBe(
      true
    )
  })
})
