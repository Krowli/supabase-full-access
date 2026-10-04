import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMocks } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import contentHandler from '../../../../../../../pages/api/platform/projects/[ref]/content'
import countHandler from '../../../../../../../pages/api/platform/projects/[ref]/content/count'
import itemHandler from '../../../../../../../pages/api/platform/projects/[ref]/content/item/[id]'
import { generateDeterministicUuid } from '@/lib/api/snippets.browser'

const { snippetsDir } = vi.hoisted(() => ({ snippetsDir: { path: '' } }))

vi.mock('@/lib/constants', () => ({ IS_PLATFORM: false }))
vi.mock('@/lib/api/snippets.constants', () => ({
  get SNIPPETS_DIR() {
    return snippetsDir.path
  },
}))

const NOTEBOOK_ID = '3f0f7c1e-8a52-4c39-9d2a-2b8f1f0e6a01'
const SNIPPET_ID = generateDeterministicUuid([null, 'users.sql'])

const notebookBody = (name = 'Revenue') => ({
  id: NOTEBOOK_ID,
  name,
  type: 'notebook',
  visibility: 'project',
  content: { schema_version: 1, cells: [{ _tag: 'markdown_cell', text: '# Revenue' }] },
})

const call = async (
  handler: typeof contentHandler,
  options: Parameters<typeof createMocks>[0]
): Promise<{ status: number; body: any }> => {
  const { req, res } = createMocks({ query: { ref: 'default' }, ...options })
  await handler(req, res)
  const data = res._getData()
  // `res.json` leaves a string; the DELETE handler's `res.send(array)` leaves the array itself.
  const body = typeof data === 'string' && data !== '' ? JSON.parse(data) : data
  return { status: res._getStatusCode(), body }
}

const saveNotebook = (name?: string) =>
  call(contentHandler, { method: 'PUT', body: notebookBody(name) })

describe('content API — notebooks next to SQL snippets', () => {
  beforeEach(() => {
    snippetsDir.path = mkdtempSync(join(tmpdir(), 'studio-content-'))
    writeFileSync(join(snippetsDir.path, 'users.sql'), 'select * from users;')
  })

  afterEach(() => {
    rmSync(snippetsDir.path, { recursive: true, force: true })
  })

  describe('PUT /content', () => {
    it('saves a notebook and answers with its cells carrying ids', async () => {
      const { status, body } = await saveNotebook()

      expect(status).toBe(200)
      expect(body).toMatchObject({ id: NOTEBOOK_ID, type: 'notebook', name: 'Revenue' })
      expect(body.content.cells[0]._id).toMatch(/^[0-9a-f-]{36}$/)
      expect(readdirSync(snippetsDir.path).sort()).toEqual(['.notebooks', 'users.sql'])
    })

    it('answers 400 for a notebook body it cannot accept', async () => {
      const { status } = await call(contentHandler, {
        method: 'PUT',
        body: { ...notebookBody(), content: { schema_version: 1, cells: [{ _tag: 'nope' }] } },
      })

      expect(status).toBe(400)
      expect(existsSync(join(snippetsDir.path, '.notebooks'))).toBe(false)
    })

    it('still saves a SQL snippet as a .sql file', async () => {
      const { status } = await call(contentHandler, {
        method: 'PUT',
        body: {
          id: generateDeterministicUuid([null, 'orders.sql']),
          name: 'orders',
          type: 'sql',
          visibility: 'user',
          content: { sql: 'select * from orders;', content_id: 'c', schema_version: '1.0' },
        },
      })

      expect(status).toBe(200)
      expect(readdirSync(snippetsDir.path).sort()).toEqual(['orders.sql', 'users.sql'])
    })
  })

  describe('GET /content', () => {
    it('lists only notebooks for type=notebook', async () => {
      await saveNotebook()

      const { status, body } = await call(contentHandler, {
        method: 'GET',
        query: { ref: 'default', type: 'notebook' },
      })

      expect(status).toBe(200)
      expect(body.data.map((row: { id: string }) => row.id)).toEqual([NOTEBOOK_ID])
    })

    it('lists only SQL snippets without a type, and no notebooks folder among them', async () => {
      await saveNotebook()

      const { body } = await call(contentHandler, { method: 'GET' })

      expect(body.data.map((row: { name: string }) => row.name)).toEqual(['users'])
    })
  })

  describe('GET /content/item/[id]', () => {
    it('answers with a notebook', async () => {
      await saveNotebook()

      const { status, body } = await call(itemHandler, {
        method: 'GET',
        query: { ref: 'default', id: NOTEBOOK_ID },
      })

      expect(status).toBe(200)
      expect(body).toMatchObject({ id: NOTEBOOK_ID, type: 'notebook' })
    })

    it('still answers with a SQL snippet', async () => {
      const { status, body } = await call(itemHandler, {
        method: 'GET',
        query: { ref: 'default', id: SNIPPET_ID },
      })

      expect(status).toBe(200)
      expect(body).toMatchObject({ id: SNIPPET_ID, type: 'sql' })
    })

    it('answers 404 for an id that is neither', async () => {
      const { status } = await call(itemHandler, {
        method: 'GET',
        query: { ref: 'default', id: '6b1d2a44-0c3e-4f7a-8e19-5d7c9a3b2c02' },
      })

      expect(status).toBe(404)
    })
  })

  describe('DELETE /content', () => {
    it('deletes a notebook and a SQL snippet in one call', async () => {
      await saveNotebook()

      const { status, body } = await call(contentHandler, {
        method: 'DELETE',
        query: { ref: 'default', ids: `${NOTEBOOK_ID},${SNIPPET_ID}` },
      })

      expect(status).toBe(200)
      expect(body).toEqual([{ id: NOTEBOOK_ID }, { id: SNIPPET_ID }])
      expect(readdirSync(join(snippetsDir.path, '.notebooks'))).toEqual([])
      expect(existsSync(join(snippetsDir.path, 'users.sql'))).toBe(false)
    })
  })

  describe('GET /content/count', () => {
    it('counts notebooks as shared for type=notebook, the way Explorer reads them', async () => {
      await saveNotebook()

      const { body } = await call(countHandler, {
        method: 'GET',
        query: { ref: 'default', type: 'notebook' },
      })

      expect(body).toEqual({ shared: 1, favorites: 0, private: 0 })
    })

    it('counts notebooks matching a name', async () => {
      await saveNotebook('Revenue')

      const { body } = await call(countHandler, {
        method: 'GET',
        query: { ref: 'default', type: 'notebook', name: 'rev' },
      })

      expect(body).toEqual({ count: 1 })
    })

    it('still counts SQL snippets without a type', async () => {
      await saveNotebook()

      const { body } = await call(countHandler, { method: 'GET' })

      expect(body).toEqual({ shared: 0, favorites: 0, private: 1 })
    })
  })
})
