import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { buildStack, stackEnvFile } from '../src/runner/stack.ts'
import { loadTemplate, renderTemplate, templateValues } from '../src/template.ts'

const id = 'abcdefghij0123456789wxyz'
const ref = 'qwertyuiopasdfghjklz'
const rendered = renderTemplate(
  loadTemplate(resolve(import.meta.dirname, '../../../deploy/platform/project-compose.yaml')),
  templateValues(
    ref,
    'supa.example.com',
    { s3Endpoint: 'http://minio:9000', s3Region: 'us-east-1', imgproxyUrl: 'http://imgproxy:8080' },
    '/data/projects'
  )
)

describe('buildStack', () => {
  const stack = buildStack(rendered, id)
  const compose = parse(stack.compose)

  it('names containers, volumes and the network the way Coolify did, so existing stacks are taken over', () => {
    expect(Object.keys(compose.services)).toEqual([
      'supabase-db',
      'supabase-rest',
      'supabase-auth',
      'supabase-storage',
    ])
    for (const [name, svc] of Object.entries<Record<string, unknown>>(compose.services)) {
      expect(svc.container_name).toBe(`${name}-${id}`)
      expect(svc.restart).toBe('unless-stopped')
      expect(svc.networks).toEqual([id])
      expect(svc.labels).toEqual({ 'supa.stack': id, 'supa.service': name })
    }
    expect(compose.volumes).toEqual({
      [`${id}_supabase-db-data`]: { name: `${id}_supabase-db-data` },
      [`${id}_supabase-db-config`]: { name: `${id}_supabase-db-config` },
    })
    expect(compose.networks).toEqual({ [id]: { name: id, external: true } })
    const dbVolumes = compose.services['supabase-db'].volumes
    expect(dbVolumes).toContain(`${id}_supabase-db-data:/var/lib/postgresql/data`)
    expect(dbVolumes).toContain(`${id}_supabase-db-config:/etc/postgresql-custom`)
  })

  it('keeps the shared network out of the compose file and lists the containers to attach to it', () => {
    expect(Object.keys(compose.networks)).toEqual([id])
    for (const svc of Object.values<{ networks: string[] }>(compose.services))
      expect(svc.networks).toEqual([id])
    expect(stack.containers).toEqual([
      `supabase-db-${id}`,
      `supabase-rest-${id}`,
      `supabase-auth-${id}`,
      `supabase-storage-${id}`,
    ])
  })

  it('turns inline content mounts into stack files and drops Coolify-only keys', () => {
    expect(stack.files.map((f) => f.path)).toEqual([
      'volumes/db/webhooks.sql',
      'volumes/db/roles.sql',
      'volumes/db/jwt.sql',
    ])
    expect(stack.files[1].content).toContain('ALTER USER authenticator WITH PASSWORD')
    expect(stack.compose).not.toMatch(/content:|exclude_from_hc/)
    const binds = compose.services['supabase-db'].volumes.filter(
      (v: unknown) => typeof v === 'object'
    )
    expect(binds.map((b: { source: string }) => b.source)).toEqual([
      './volumes/db/webhooks.sql',
      './volumes/db/roles.sql',
      './volumes/db/jwt.sql',
    ])
  })

  it('leaves the secrets as ${...} for compose to fill from the stack .env', () => {
    expect(stack.compose).toContain('${PROJECT_DB_PASSWORD}')
    expect(stack.compose).toContain('${S3_SECRET_KEY}')
    expect(stack.compose).toContain(`https://${ref}.supa.example.com`)
  })

  it('refuses a malformed stack id', () => {
    expect(() => buildStack(rendered, 'Not-An-Id')).toThrow(/Invalid stack id/)
  })
})

describe('stackEnvFile', () => {
  it('writes the known keys', () => {
    expect(stackEnvFile({ PROJECT_DB_PASSWORD: 'abc123', PROJECT_ANON_KEY: 'eyJ.a-b_c.d' })).toBe(
      'PROJECT_DB_PASSWORD=abc123\nPROJECT_ANON_KEY=eyJ.a-b_c.d\n'
    )
  })
  it('refuses other keys and unsafe values', () => {
    expect(() => stackEnvFile({ POSTGRES_HOST: 'x' })).toThrow(/Unknown stack variable/)
    expect(() => stackEnvFile({ PROJECT_DB_PASSWORD: 'a\nINJECT=1' })).toThrow(/unsafe/)
    expect(() => stackEnvFile({ PROJECT_DB_PASSWORD: '${HOME}' })).toThrow(/unsafe/)
  })
})
