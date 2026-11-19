/**
 * Time per request through the OAuth-client rule with hostile Authorization headers (see
 * probe.mjs for the setup). storage-v1 and functions-v1 need no project key, so anyone can send
 * these. Prints the median and the worst of N sequential requests per case, in milliseconds, and
 * exits 1 when a hostile header costs more than LIMIT_MS (default 25) above the plain request.
 *
 *   node timing.mjs            # Kong on 59802
 *   KONG_PORT=59803 node timing.mjs
 */
const PORT = process.env.KONG_PORT ?? '59802'
const BASE = `http://fintwoninefiveaaaaaa.localtest.me:${PORT}`
const N = Number(process.env.N ?? 30)
const LIMIT_MS = Number(process.env.LIMIT_MS ?? 25)
const letters = 'a'.repeat(8000)
const dots = 'a.'.repeat(4000)
const words = Array.from({ length: 1000 }, () => 'aaaa.bbbb').join(' ')
const cases = [
  ['plain request, no Authorization', undefined],
  ['Bearer + 8 KB of letters (no dot)', `Bearer ${letters}`],
  ['Bearer + 8 KB of a.a.a.', `Bearer ${dots}`],
  ['1000 words of aaaa.bbbb', words],
  ['Bearer + 8 KB letters with one dot in the middle', `Bearer ${letters.slice(0, 4000)}.${letters.slice(0, 4000)}`],
]
let worstExtra = 0
let baseline = 0
for (const [name, authorization] of cases) {
  const times = []
  let status = 0
  for (let i = 0; i < N; i++) {
    const headers = authorization ? { Authorization: authorization } : {}
    const t0 = performance.now()
    const r = await fetch(`${BASE}/storage/v1/bucket`, { headers })
    await r.arrayBuffer()
    times.push(performance.now() - t0)
    status = r.status
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(N / 2)]
  if (!authorization) baseline = median
  else worstExtra = Math.max(worstExtra, median - baseline)
  console.log(`${name.padEnd(52)} status ${status}  median ${median.toFixed(1)} ms  worst ${times[N - 1].toFixed(1)} ms`)
}
console.log(`worst extra median over the plain request: ${worstExtra.toFixed(1)} ms (limit ${LIMIT_MS})`)
process.exit(worstExtra > LIMIT_MS ? 1 : 0)
