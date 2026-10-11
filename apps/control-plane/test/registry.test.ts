import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPgRegistry, migrate } from '../src/registry.ts'
import { generateProjectSecrets, generateRef } from '../src/secrets.ts'

// Needs a throwaway Postgres, e.g.
//   docker run -d --rm --name cp-test-pg -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:54329/postgres npm test
const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('Postgres registry', () => {
  const pool = new pg.Pool({ connectionString: url })
  const key = randomBytes(32)
  const registry = createPgRegistry(pool, key)

  beforeAll(async () => {
    await pool.query('drop schema if exists _platform cascade')
    await migrate(pool)
  })
  afterAll(async () => {
    await pool.query('drop schema if exists _platform cascade')
    await pool.end()
  })

  it('migrates idempotently, also concurrently', async () => {
    await Promise.all([migrate(pool), migrate(pool), migrate(pool)])
  })

  it('stores secrets encrypted and reads them back', async () => {
    const ref = generateRef()
    const secrets = generateProjectSecrets(ref)
    const p = await registry.insert({ ref, name: 'Demo' }, secrets)
    expect(p).toMatchObject({ ref, name: 'Demo', status: 'CREATING', coolify_service_uuid: null })

    const { rows } = await pool.query('select * from _platform.project_secrets where ref = $1', [
      ref,
    ])
    for (const [column, value] of Object.entries(secrets)) {
      expect(rows[0][column]).toMatch(/^v1\./)
      expect(rows[0][column]).not.toContain(value)
    }
    expect(await registry.getSecrets(ref)).toEqual(secrets)
    await expect(createPgRegistry(pool, randomBytes(32)).getSecrets(ref)).rejects.toThrow()
  })

  it('updates, lists by status, rejects unknown statuses and cascades deletes', async () => {
    const ref = generateRef()
    await registry.insert({ ref, name: 'Two' }, generateProjectSecrets(ref))
    await registry.update(ref, { status: 'FAILED', last_error: 'boom', coolify_service_uuid: 'u1' })
    const p = (await registry.get(ref))!
    expect(p).toMatchObject({ status: 'FAILED', last_error: 'boom', coolify_service_uuid: 'u1' })
    expect(p.updated_at.getTime()).toBeGreaterThanOrEqual(p.created_at.getTime())
    expect((await registry.listByStatus(['FAILED'])).map((x) => x.ref)).toContain(ref)
    await expect(registry.update(ref, { status: 'NOPE' as never })).rejects.toThrow()

    await registry.delete(ref)
    expect(await registry.get(ref)).toBeNull()
    const { rowCount } = await pool.query(
      'select 1 from _platform.project_secrets where ref = $1',
      [ref]
    )
    expect(rowCount).toBe(0)
  })
})
