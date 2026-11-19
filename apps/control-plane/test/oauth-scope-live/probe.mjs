/**
 * oauthClientScope (src/kong.ts) through a real kong/kong:3.9.1 with the config renderKongConfig
 * renders, against a throwaway Supabase project: not part of `npm test`, run by hand.
 *
 * Setup (all local, containers named fin295-*):
 * 1. The throwaway stack of Krowli/finance-pit38-zg, scripts/e2e/scoped-keys/stack.sh up
 *    (GoTrue v2.196.0 with the OAuth server, PostgREST, Storage, the access-token hook on).
 *    Its state directory (JWT secret, anon and service keys) is $SCOPED_KEYS_STATE.
 * 2. node render.mjs: two projects, A (fintwoninefiveaaaaaa) and B (otherprojectbbbbbbbb), both
 *    routed to that stack (network aliases supabase-<svc>-fin295a/-fin295b on fin295-auth,
 *    fin295-rest, fin295-storage), host suffix localtest.me (resolves to 127.0.0.1).
 * 3. kong/kong:3.9.1 on fin295-net, port 127.0.0.1:59802, with the platform's KONG_PLUGINS and
 *    KONG_UNTRUSTED_LUA_SANDBOX_REQUIRES=cjson.safe; POST kong.json to its admin /config.
 * 4. node probe.mjs → ALL PASSED. Without the sandbox setting (KONG_PORT pointing at such a Kong)
 *    the rule logs "cjson.safe is not allowed" and lets requests through.
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const S = (process.env.SCOPED_KEYS_STATE ?? join(process.env.TMPDIR ?? '/tmp', 'fin295-state')) + '/'
const K = new URL('.', import.meta.url).pathname
const r = (f) => readFileSync(f, 'utf8').trim()
const A = { base: 'http://fintwoninefiveaaaaaa.localtest.me:59802', anon: r(S + 'anon.jwt') }
const B = { base: 'http://otherprojectbbbbbbbb.localtest.me:59802', anon: r(K + 'anon-b.jwt') }
const SERVICE = r(S + 'service.jwt')
const PORT = process.env.KONG_PORT ?? '59802'
for (const p of [A, B]) p.base = p.base.replace('59802', PORT)
let failed = 0
const check = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(70)} ${detail}`) }
async function call(p, method, path, { token, body, form, apikey = true } = {}) {
  const h = {}
  if (apikey) h.apikey = p.anon
  if (token) h.Authorization = `Bearer ${token}`
  let payload
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString() }
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(p.base + path, { method, headers: h, body: payload, redirect: 'manual' })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text: text.slice(0, 90).replace(/\s+/g, ' '), headers: res.headers }
}
const scoped = (x) => x.status === 403 && x.json?.code === 'oauth_client_token_scope'

const email = `kongk-${Date.now()}@example.test`, password = 'Kongk-pass-1!'
const created = await call(A, 'POST', '/auth/v1/admin/users', { token: SERVICE, body: { email, password, email_confirm: true } })
const site = (await call(A, 'POST', '/auth/v1/token?grant_type=password', { body: { email, password } })).json
const reg = (await call(A, 'POST', '/auth/v1/oauth/clients/register', { apikey: false, body: { client_name: 'kongk', redirect_uris: ['http://localhost:9999/cb'], token_endpoint_auth_method: 'none' } })).json
const v = randomBytes(32).toString('base64url'), c = createHash('sha256').update(v).digest('base64url')
const az = await call(A, 'GET', '/auth/v1/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://localhost:9999/cb', scope: 'email', code_challenge: c, code_challenge_method: 'S256' }), { apikey: false })
const id = new URL(az.headers.get('location')).searchParams.get('authorization_id')
const det = await call(A, 'GET', `/auth/v1/oauth/authorizations/${id}`, { token: site.access_token })
check('site token: consent details (keyed auth-v1)', det.status === 200, `${det.status}`)
const cons = await call(A, 'POST', `/auth/v1/oauth/authorizations/${id}/consent`, { token: site.access_token, body: { action: 'approve' } })
const code = new URL(cons.json.redirect_url).searchParams.get('code')
const tok = await call(A, 'POST', '/auth/v1/oauth/token', { apikey: false, form: { grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:9999/cb', client_id: reg.client_id, code_verifier: v } })
check('open /oauth/token (code exchange, no key)', tok.status === 200, `${tok.status}`)
const oa = tok.json.access_token

console.log('-- assistant token, project A')
check('GET /auth/v1/user (the MCP check)', (await call(A, 'GET', '/auth/v1/user', { token: oa })).status === 200, '')
const ui = await call(A, 'GET', '/auth/v1/oauth/userinfo', { token: oa })
check('GET /auth/v1/oauth/userinfo reaches GoTrue', !scoped(ui), `${ui.status} ${ui.text}`)
for (const [m, p, b] of [
  ['PUT', '/auth/v1/user', { password: 'Changed-by-assistant-1!' }],
  ['PUT', '/auth/v1/user', { email: 'attacker@example.test' }],
  ['POST', '/auth/v1/factors', { factor_type: 'totp', friendly_name: 'x' }],
  ['GET', '/auth/v1/reauthenticate'],
  ['GET', '/auth/v1/user/oauth/grants'],
  ['GET', `/auth/v1/oauth/authorizations/${id}`],
  ['POST', '/auth/v1/logout?scope=global'],
  ['GET', `/rest/v1/users?select=id&id=eq.${created.json.id}`],
  ['POST', '/rest/v1/rpc/get_fx_stats', {}],
  ['POST', '/graphql/v1', { query: '{ __typename }' }],
  ['POST', '/storage/v1/object/list/throwaway', { prefix: 'x' }],
  ['GET', '/storage/v1/bucket'],
  ['POST', '/functions/v1/admin-users', {}],
  ['GET', '/realtime/v1/api/broadcast'],
]) {
  const x = await call(A, m, p, { token: oa, body: b })
  check(`refused by Kong: ${m} ${p.slice(0, 48)}`, scoped(x), `${x.status} ${x.json?.code ?? x.text}`)
}
const rr = await call(A, 'POST', '/auth/v1/oauth/token', { apikey: false, form: { grant_type: 'refresh_token', refresh_token: tok.json.refresh_token, client_id: reg.client_id } })
check('open /oauth/token (refresh, no key)', rr.status === 200, `${rr.status}`)
check('the refreshed assistant token: GET /auth/v1/user', (await call(A, 'GET', '/auth/v1/user', { token: rr.json.access_token })).status === 200, '')
check('the refreshed assistant token: PUT /auth/v1/user refused', scoped(await call(A, 'PUT', '/auth/v1/user', { token: rr.json.access_token, body: { password: 'X-1-assistant!' } })), '')
const [h, pl, sig] = oa.split('.')
const edited = JSON.parse(Buffer.from(pl, 'base64url').toString()); delete edited.client_id; edited.role = 'authenticated'
const forged = `${h}.${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${sig}`
const f = await call(A, 'PUT', '/auth/v1/user', { token: forged, body: { password: 'X-forged-1!' } })
check('claims edited out: Kong lets it pass, GoTrue refuses the signature', f.status === 403 && f.json?.error_code === 'bad_jwt', `${f.status} ${f.json?.error_code}`)
// A token whose user_metadata carries "client_id" and "role":"oauth_client" is not an assistant token.
const meta = await call(A, 'PUT', '/auth/v1/user', { token: site.access_token, body: { data: { client_id: 'abc', role: 'oauth_client' } } })
const metaSite = (await call(A, 'POST', '/auth/v1/token?grant_type=password', { body: { email, password } })).json.access_token
check('user_metadata client_id/role does not trigger the rule (PUT /user)', meta.status === 200 && (await call(A, 'PUT', '/auth/v1/user', { token: metaSite, body: { data: { x: 1 } } })).status === 200, `${meta.status}`)

console.log('-- site session and anon, project A')
check('site: GET /auth/v1/user', (await call(A, 'GET', '/auth/v1/user', { token: site.access_token })).status === 200, '')
check('site: PUT /auth/v1/user {data}', (await call(A, 'PUT', '/auth/v1/user', { token: site.access_token, body: { data: { y: 1 } } })).status === 200, '')
check('site: GET /rest/v1/users own row', (await call(A, 'GET', `/rest/v1/users?select=id&id=eq.${created.json.id}`, { token: site.access_token })).status === 200, '')
check('site: GET /auth/v1/user/oauth/grants', (await call(A, 'GET', '/auth/v1/user/oauth/grants', { token: site.access_token })).status === 200, '')
check('site: GET /storage/v1/bucket', (await call(A, 'GET', '/storage/v1/bucket', { token: site.access_token })).status === 200, '')
check('anon key only: GET /rest/v1/fx_rates', (await call(A, 'GET', '/rest/v1/fx_rates?select=id&limit=1')).status === 200, '')
check('no key at all: still 401 from key-auth', (await call(A, 'GET', '/rest/v1/fx_rates?select=id', { apikey: false })).status === 401, '')
check('a non-JWT bearer passes to the upstream', !scoped(await call(A, 'GET', '/rest/v1/fx_rates?select=id', { token: 'not-a-jwt' })), '')
check('open: discovery document', (await call(A, 'GET', '/.well-known/oauth-authorization-server/auth/v1', { apikey: false })).status === 200, '')

console.log('-- project B (other project) unchanged')
const siteB = (await call(B, 'POST', '/auth/v1/token?grant_type=password', { body: { email, password } })).json
check('B site: sign-in', !!siteB.access_token, '')
check('B site: GET /auth/v1/user', (await call(B, 'GET', '/auth/v1/user', { token: siteB.access_token })).status === 200, '')
check('B site: PUT /auth/v1/user {data}', (await call(B, 'PUT', '/auth/v1/user', { token: siteB.access_token, body: { data: { z: 1 } } })).status === 200, '')
check('B anon: GET /rest/v1/fx_rates', (await call(B, 'GET', '/rest/v1/fx_rates?select=id&limit=1')).status === 200, '')
check("B: project A's anon key is refused (keys stay per project)", (await call({ ...B, anon: A.anon }, 'GET', '/rest/v1/fx_rates?select=id')).status >= 401, '')
check('B: an assistant token is limited there too', scoped(await call(B, 'PUT', '/auth/v1/user', { token: oa, body: { data: { q: 1 } } })), '')

await call(A, 'DELETE', `/auth/v1/admin/users/${created.json.id}`, { token: SERVICE })
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)
