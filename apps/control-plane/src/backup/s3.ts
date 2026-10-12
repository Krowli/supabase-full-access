// The one S3 call restic cannot make for us: is there a lifecycle rule on the destination that
// deletes old objects? restic keeps data that has not changed in old pack files, so a rule like
// "delete after 30 days" silently breaks every snapshot, including today's. S3 (and R2) answer a
// HEAD of an object with `x-amz-expiration` when a rule will delete it.

import { createHash, createHmac } from 'node:crypto'

import type { S3Destination } from './config.ts'

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex')
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest()
const EMPTY_SHA256 = sha256('')

/** AWS Signature Version 4 headers for a request without a body. */
export function signV4(req: {
  method: string
  url: URL
  headers?: Record<string, string>
  accessKeyId: string
  secretAccessKey: string
  region: string
  now?: Date
}): Record<string, string> {
  const amzDate = (req.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const headers: Record<string, string> = {
    host: req.url.host,
    ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    'x-amz-content-sha256': EMPTY_SHA256,
    'x-amz-date': amzDate,
  }
  const names = Object.keys(headers).sort()
  const query = [...req.url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonical = [
    req.method,
    req.url.pathname,
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    EMPTY_SHA256,
  ].join('\n')
  const scope = `${day}/${req.region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac(`AWS4${req.secretAccessKey}`, day), req.region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope},SignedHeaders=${names.join(';')},Signature=${signature}`,
  }
}

/** The rule id in an `x-amz-expiration` header, or null. */
export function expiryOf(header: string | null): string | null {
  if (!header) return null
  return /rule-id="([^"]*)"/.exec(header)?.[1] ?? 'unnamed rule'
}

/** The lifecycle rule that would delete `key` (path-style URL), or null when none applies. */
export async function lifecycleRule(d: S3Destination, key: string): Promise<string | null> {
  const url = new URL(`${d.endpoint}/${[d.bucket, d.prefix, key].filter(Boolean).join('/')}`)
  const headers = signV4({
    method: 'HEAD',
    url,
    accessKeyId: d.access_key_id,
    secretAccessKey: d.secret_access_key,
    region: d.region ?? 'auto',
  })
  delete headers.host
  const res = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`HEAD ${key} on ${d.endpoint} answered ${res.status}`)
  return expiryOf(res.headers.get('x-amz-expiration'))
}
