import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  countNotebooks,
  deleteNotebook,
  getNotebook,
  listNotebooks,
  NotebookValidationError,
  upsertNotebook,
} from './notebooks'

const ID_A = '3f0f7c1e-8a52-4c39-9d2a-2b8f1f0e6a01'
const ID_B = '6b1d2a44-0c3e-4f7a-8e19-5d7c9a3b2c02'
const ID_C = 'a9e8d7c6-b5a4-4321-8fed-cba987654303'

const body = (id: string, name: string, cells: unknown[] = []) => ({
  id,
  name,
  type: 'notebook',
  visibility: 'project',
  content: { schema_version: 1, cells },
})

describe('self-hosted notebooks', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-notebooks-'))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T10:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('upsertNotebook', () => {
    it('saves a new notebook as a project-visible notebook row', async () => {
      const row = await upsertNotebook(body(ID_A, 'Revenue'), dir)

      expect(row).toMatchObject({
        id: ID_A,
        name: 'Revenue',
        type: 'notebook',
        visibility: 'project',
        favorite: false,
        folder_id: null,
        inserted_at: '2026-10-01T10:00:00.000Z',
        updated_at: '2026-10-01T10:00:00.000Z',
        content: { schema_version: 1, cells: [] },
      })
    })

    it('gives a cell sent without an _id a new one, and keeps an _id it was sent', async () => {
      const row = await upsertNotebook(
        body(ID_A, 'Cells', [
          { _tag: 'markdown_cell', text: '# Title' },
          { _tag: 'database_cell', _id: 'kept-id', sql: 'select 1', row_limit: 100 },
        ]),
        dir
      )

      const [markdown, database] = row.content.cells
      expect(markdown._id).toMatch(/^[0-9a-f-]{36}$/)
      expect(database._id).toBe('kept-id')
    })

    it('updates an existing notebook in place and keeps when it was created', async () => {
      await upsertNotebook(body(ID_A, 'Before'), dir)
      vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'))

      const row = await upsertNotebook(
        body(ID_A, 'After', [{ _tag: 'markdown_cell', text: 'x' }]),
        dir
      )

      expect(row.name).toBe('After')
      expect(row.inserted_at).toBe('2026-10-01T10:00:00.000Z')
      expect(row.updated_at).toBe('2026-10-02T12:00:00.000Z')
      expect(row.content.cells).toHaveLength(1)
    })

    it('writes one file per notebook, named by its lowercased id', async () => {
      await upsertNotebook(body(ID_A.toUpperCase(), 'Upper'), dir)

      expect(readdirSync(dir)).toEqual([`${ID_A}.json`])
    })

    it.each([
      ['a SQL snippet', { ...body(ID_A, 'x'), type: 'sql' }],
      ['an id that is not a uuid', body('../escape', 'x')],
      ['a cell with an unknown tag', body(ID_A, 'x', [{ _tag: 'chart_cell' }])],
      ['content with the wrong schema version', { ...body(ID_A, 'x'), content: { cells: [] } }],
    ])('refuses %s', async (_label, payload) => {
      await expect(upsertNotebook(payload, dir)).rejects.toBeInstanceOf(NotebookValidationError)
      expect(readdirSync(dir)).toEqual([])
    })
  })

  describe('getNotebook', () => {
    it('reads back what was saved', async () => {
      const saved = await upsertNotebook(body(ID_A, 'Saved'), dir)

      expect(await getNotebook(ID_A, dir)).toEqual(saved)
    })

    it.each([
      ['an id nothing was saved under', ID_B],
      ['an id that is not a uuid', 'not-a-uuid'],
    ])('answers undefined for %s', async (_label, id) => {
      expect(await getNotebook(id, dir)).toBeUndefined()
    })
  })

  describe('listNotebooks', () => {
    beforeEach(async () => {
      await upsertNotebook(body(ID_A, 'beta'), dir)
      vi.setSystemTime(new Date('2026-10-01T11:00:00.000Z'))
      await upsertNotebook(body(ID_B, 'Alpha'), dir)
      vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'))
      await upsertNotebook(body(ID_C, 'gamma report'), dir)
    })

    it('lists newest first by default', async () => {
      const { notebooks, cursor } = await listNotebooks({}, dir)

      expect(notebooks.map((n) => n.name)).toEqual(['gamma report', 'Alpha', 'beta'])
      expect(cursor).toBeUndefined()
    })

    it('sorts by name without regard to case', async () => {
      const { notebooks } = await listNotebooks({ sort: 'name', sortOrder: 'asc' }, dir)

      expect(notebooks.map((n) => n.name)).toEqual(['Alpha', 'beta', 'gamma report'])
    })

    it('searches names without regard to case', async () => {
      const { notebooks } = await listNotebooks({ searchTerm: 'GAMMA' }, dir)

      expect(notebooks.map((n) => n.id)).toEqual([ID_C])
    })

    it('pages with a limit and the cursor it hands back', async () => {
      const first = await listNotebooks({ limit: 2 }, dir)
      const second = await listNotebooks({ limit: 2, cursor: first.cursor }, dir)

      expect(first.notebooks.map((n) => n.id)).toEqual([ID_C, ID_B])
      expect(first.cursor).toBe(ID_B)
      expect(second.notebooks.map((n) => n.id)).toEqual([ID_A])
      expect(second.cursor).toBeUndefined()
    })
  })

  it('lists nothing when the notebooks folder does not exist yet', async () => {
    const { notebooks } = await listNotebooks({}, join(dir, 'missing'))

    expect(notebooks).toEqual([])
  })

  describe('deleteNotebook', () => {
    it('removes a saved notebook and says it did', async () => {
      await upsertNotebook(body(ID_A, 'Gone'), dir)

      expect(await deleteNotebook(ID_A, dir)).toBe(true)
      expect(await getNotebook(ID_A, dir)).toBeUndefined()
    })

    it.each([
      ['an id nothing was saved under', ID_B],
      ['an id that is not a uuid', 'not-a-uuid'],
    ])('answers false for %s', async (_label, id) => {
      expect(await deleteNotebook(id, dir)).toBe(false)
    })
  })

  describe('countNotebooks', () => {
    it('counts every notebook, or the ones whose name matches a search', async () => {
      await upsertNotebook(body(ID_A, 'Revenue'), dir)
      await upsertNotebook(body(ID_B, 'Churn'), dir)

      expect(await countNotebooks(undefined, dir)).toBe(2)
      expect(await countNotebooks('rev', dir)).toBe(1)
    })
  })
})
