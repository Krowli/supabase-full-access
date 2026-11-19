/** Renders the two-project Kong config probe.mjs runs against (see its header). */
import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderKongConfig } from '../../src/kong.ts'

const S = process.env.SCOPED_KEYS_STATE ?? join(process.env.TMPDIR ?? '/tmp', 'fin295-state')
const K = new URL('.', import.meta.url).pathname
const r = (f) => readFileSync(f, 'utf8').trim()
const secret = r(join(S, 'secret'))
const mint = (role) => {
  const part = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ role, iss: 'supabase', iat: Math.floor(Date.now() / 1000), ref: 'b' })}`
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`
}
writeFileSync(join(K, 'anon-b.jwt'), mint('anon'))
const projects = [
  { ref: 'fintwoninefiveaaaaaa', uuid: 'fin295a', anonKey: r(join(S, 'anon.jwt')), serviceKey: r(join(S, 'service.jwt')), functions: true },
  { ref: 'otherprojectbbbbbbbb', uuid: 'fin295b', anonKey: r(join(K, 'anon-b.jwt')), serviceKey: mint('service_role') },
]
writeFileSync(join(K, 'kong.json'), JSON.stringify(renderKongConfig(projects, { domainSuffix: 'localtest.me', realtimeUrl: 'http://fin295-realtime:4000' })))
console.log('kong.json written')
