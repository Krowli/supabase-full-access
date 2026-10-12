import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { generateProjectSecrets } from '../src/secrets.ts'
import { loadTemplate, renderTemplate, serviceEnvs, templateValues } from '../src/template.ts'

const repo = resolve(import.meta.dirname, '../../..')
const template = loadTemplate(resolve(repo, 'deploy/platform/project-compose.yaml'))
const ref = 'abcdefghijklmnopqrst'
const shared = {
  s3Endpoint: 'http://minio-abc:9000',
  s3Region: 'us-east-1',
  imgproxyUrl: 'http://imgproxy-abc:8080',
}

type Compose = {
  services: Record<
    string,
    { image: string; environment: string[]; ports?: unknown; volumes?: unknown[] }
  >
}
const projectsDir = '/data/platform/projects'
const render = () =>
  renderTemplate(template, templateValues(ref, 'supa.example.com', shared, projectsDir))
const envOf = (compose: Compose, service: string) =>
  Object.fromEntries(
    compose.services[service].environment.map((e) => e.split(/=(.*)/s).slice(0, 2))
  )

describe('renderTemplate', () => {
  it('replaces placeholders and rejects unknown ones and unsafe values', () => {
    const values = templateValues(ref, 'x.com', shared, projectsDir)
    expect(renderTemplate('a={{REF}} b={{PUBLIC_URL}}', values)).toBe(
      `a=${ref} b=https://${ref}.x.com`
    )
    expect(() => renderTemplate('{{NOPE}}', values)).toThrow(/NOPE/)
    expect(() => renderTemplate('{{REF}}', { ...values, REF: 'a\nb: c' })).toThrow(/unsafe/)
    expect(() => renderTemplate('{{REF}}', { ...values, REF: '${X}' })).toThrow(/unsafe/)
  })
})

describe('project-compose.yaml', () => {
  it('renders to a compose with exactly db, auth, rest and storage, and no published ports', () => {
    const out = render()
    expect(out).not.toMatch(/\{\{[A-Z0-9_]+\}\}/)
    const compose = parse(out) as Compose
    expect(Object.keys(compose.services).sort()).toEqual([
      'supabase-auth',
      'supabase-db',
      'supabase-rest',
      'supabase-storage',
    ])
    for (const svc of Object.values(compose.services)) expect(svc.ports).toBeUndefined()
  })

  it('uses the same images as the fork compose', () => {
    const fork = parse(
      readFileSync(resolve(repo, 'deploy/coolify/docker-compose.yaml'), 'utf8')
    ) as Compose
    const compose = parse(render()) as Compose
    for (const [name, svc] of Object.entries(compose.services)) {
      expect(svc.image, name).toBe(fork.services[name].image)
    }
  })

  it('puts the ref, URL, shared MinIO and shared imgproxy into the services', () => {
    const compose = parse(render()) as Compose
    expect(envOf(compose, 'supabase-auth').API_EXTERNAL_URL).toBe(`https://${ref}.supa.example.com`)
    const storage = envOf(compose, 'supabase-storage')
    expect(storage).toMatchObject({
      TENANT_ID: ref,
      STORAGE_BACKEND: 's3',
      STORAGE_S3_BUCKET: ref,
      STORAGE_S3_ENDPOINT: 'http://minio-abc:9000',
      ENABLE_IMAGE_TRANSFORMATION: 'true',
      IMGPROXY_URL: 'http://imgproxy-abc:8080',
    })
  })

  it('binds GoTrue and storage to the settings directories Studio writes for this ref', () => {
    const compose = parse(render()) as Compose & {
      services: Record<string, { command?: string[] }>
    }
    const auth = compose.services['supabase-auth']
    expect(auth.command).toEqual(['auth', '--config-dir', '/etc/gotrue'])
    expect(auth.volumes).toEqual([`${projectsDir}/${ref}/gotrue:/etc/gotrue:ro`])
    expect(envOf(compose, 'supabase-auth')).toMatchObject({
      GOTRUE_MAILER_TEMPLATE_RELOADING_ENABLED: 'true',
    })
    expect(compose.services['supabase-storage'].volumes).toEqual([
      `${projectsDir}/${ref}/storage:/etc/studio-config:ro`,
    ])
    // No named volume stands in for them any more.
    expect(Object.keys((parse(render()) as { volumes: object }).volumes).sort()).toEqual([
      'supabase-db-config',
      'supabase-db-data',
    ])
  })

  it('keeps every secret out of the compose and reads exactly the env vars the provisioner sets', () => {
    const secrets = generateProjectSecrets(ref)
    const out = render()
    for (const value of Object.values(secrets)) expect(out).not.toContain(value)
    // ${NAME} references in env lines (the SQL content uses $NAME without braces).
    const referenced = new Set([...out.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]))
    expect([...referenced].sort()).toEqual(Object.keys(serviceEnvs(secrets)).sort())
  })

  it('mounts the same init SQL as docker/volumes/db', () => {
    const compose = parse(render()) as {
      services: { 'supabase-db': { volumes: (string | { source: string; content?: string })[] } }
    }
    const mounts = compose.services['supabase-db'].volumes.filter(
      (v): v is { source: string; content: string } => typeof v === 'object'
    )
    expect(mounts.map((m) => m.source).sort()).toEqual([
      './volumes/db/jwt.sql',
      './volumes/db/roles.sql',
      './volumes/db/webhooks.sql',
    ])
    for (const m of mounts) {
      const file = readFileSync(resolve(repo, 'docker', m.source.slice(2)), 'utf8')
      expect(m.content.trimEnd(), m.source).toBe(file.trimEnd())
    }
  })
})
