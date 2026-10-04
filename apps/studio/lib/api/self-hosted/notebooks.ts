import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sortBy } from 'lodash'
import { z } from 'zod'

import { readJsonState, writeJsonState } from './auth-config/state'
import { notebookSchema, writableNotebookSchema } from '@/data/content/notebooks/notebook-schema'
import { SNIPPETS_DIR } from '@/lib/api/snippets.constants'

/**
 * Explorer's notebooks, self-hosted.
 *
 * On the platform a notebook is a row in the content API next to SQL snippets. Self-hosted the
 * content API is backed by `.sql` files in `SNIPPETS_MANAGEMENT_FOLDER`, which can hold nothing but
 * a snippet's SQL text, so a notebook is kept as its whole content row in one JSON file,
 * `<id>.json`, under `.notebooks` in that same folder — inside the volume the compose already
 * mounts, so notebooks survive a redeploy. The snippet listing skips dot-entries, which keeps the
 * folder from showing up in the SQL Editor as a folder of snippets.
 */
const NOTEBOOKS_DIR_NAME = '.notebooks'

export class NotebookValidationError extends Error {}

const UpsertNotebookBodySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  type: z.literal('notebook'),
  content: writableNotebookSchema,
})

const NotebookRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  type: z.literal('notebook'),
  visibility: z.literal('project'),
  favorite: z.boolean(),
  content: notebookSchema,
  inserted_at: z.string(),
  updated_at: z.string(),
  project_id: z.number(),
  folder_id: z.null(),
  owner_id: z.number(),
  owner: z.object({ id: z.number(), username: z.string() }),
  updated_by: z.object({ id: z.number(), username: z.string() }),
})

type NotebookRow = z.infer<typeof NotebookRowSchema>

// The same single user the self-hosted snippet rows name (`lib/api/snippets.utils.ts`).
const SELF_HOSTED_USER = { id: 1, username: 'johndoe' }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function getNotebooksDir(): string {
  if (SNIPPETS_DIR === '') {
    throw new Error(
      'SNIPPETS_MANAGEMENT_FOLDER env var is not set. Please set it to use notebooks properly.'
    )
  }
  return join(SNIPPETS_DIR, NOTEBOOKS_DIR_NAME)
}

/** The file a notebook id is kept in, or undefined for an id that cannot name one. */
function fileNameFor(id: string): string | undefined {
  const normalized = id.toLowerCase()
  return UUID_PATTERN.test(normalized) ? `${normalized}.json` : undefined
}

export async function getNotebook(
  id: string,
  dir = getNotebooksDir()
): Promise<NotebookRow | undefined> {
  const fileName = fileNameFor(id)
  if (fileName === undefined) return undefined

  const stored = await readJsonState(fileName, dir)
  // `readJsonState` answers `{}` for a file that does not exist.
  if (Object.keys(stored).length === 0) return undefined

  return NotebookRowSchema.parse(stored)
}

/**
 * Creates or replaces a notebook from the content API's `PUT` body. The backend owns cell ids: a
 * cell sent without an `_id` is new and gets one here, and the client parses the answer with `_id`
 * required (`data/content/notebooks/notebook-schema.ts`).
 */
export async function upsertNotebook(body: unknown, dir = getNotebooksDir()): Promise<NotebookRow> {
  const parsed = UpsertNotebookBodySchema.safeParse(body)
  if (!parsed.success) throw new NotebookValidationError(parsed.error.message)

  const { id, name, description, content } = parsed.data
  const fileName = fileNameFor(id)
  if (fileName === undefined) throw new NotebookValidationError(`invalid notebook id: ${id}`)

  const existing = await getNotebook(id, dir)
  const now = new Date().toISOString()

  const row = NotebookRowSchema.parse({
    id: id.toLowerCase(),
    name,
    description,
    type: 'notebook',
    visibility: 'project',
    favorite: false,
    content: {
      ...content,
      cells: content.cells.map((cell) => ({ ...cell, _id: cell._id ?? randomUUID() })),
    },
    inserted_at: existing?.inserted_at ?? now,
    updated_at: now,
    project_id: 1,
    folder_id: null,
    owner_id: SELF_HOSTED_USER.id,
    owner: SELF_HOSTED_USER,
    updated_by: SELF_HOSTED_USER,
  })

  await writeJsonState(fileName, row, dir)
  return row
}

/** Removes a notebook. Answers whether there was one to remove. */
export async function deleteNotebook(id: string, dir = getNotebooksDir()): Promise<boolean> {
  const fileName = fileNameFor(id)
  if (fileName === undefined) return false

  try {
    await rm(join(dir, fileName))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readAllNotebooks(dir: string): Promise<NotebookRow[]> {
  let fileNames: string[]
  try {
    fileNames = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  // Temporary files from an atomic write in progress end in `.tmp.<pid>.<n>`, not `.json`.
  const ids = fileNames
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => fileName.slice(0, -'.json'.length))

  const notebooks = await Promise.all(ids.map((id) => getNotebook(id, dir)))
  return notebooks.filter((notebook): notebook is NotebookRow => notebook !== undefined)
}

const matchesSearch = (notebook: NotebookRow, searchTerm: string | undefined) =>
  !searchTerm || notebook.name.toLowerCase().includes(searchTerm.trim().toLowerCase())

/**
 * Lists notebooks the way `getSnippets` lists snippets: newest first by default, a case-insensitive
 * name search, and a cursor that is the id of the last row of the previous page.
 */
export async function listNotebooks(
  {
    searchTerm,
    limit = 100,
    cursor,
    sort = 'inserted_at',
    sortOrder = 'desc',
  }: {
    searchTerm?: string
    limit?: number
    cursor?: string
    sort?: 'name' | 'inserted_at'
    sortOrder?: 'asc' | 'desc'
  },
  dir = getNotebooksDir()
): Promise<{ cursor: string | undefined; notebooks: NotebookRow[] }> {
  const matching = (await readAllNotebooks(dir)).filter((n) => matchesSearch(n, searchTerm))

  const sorted = sortBy(matching, (notebook) =>
    sort === 'name' ? notebook.name.toLowerCase() : notebook.inserted_at
  )
  if (sortOrder === 'desc') sorted.reverse()

  const cursorIndex = cursor ? sorted.findIndex((notebook) => notebook.id === cursor) : -1
  const afterCursor = cursorIndex === -1 ? sorted : sorted.slice(cursorIndex + 1)

  const page = afterCursor.slice(0, limit)
  const nextCursor = afterCursor.length > limit ? page[page.length - 1].id : undefined

  return { cursor: nextCursor, notebooks: page }
}

export async function countNotebooks(
  searchTerm?: string,
  dir = getNotebooksDir()
): Promise<number> {
  return (await readAllNotebooks(dir)).filter((n) => matchesSearch(n, searchTerm)).length
}
