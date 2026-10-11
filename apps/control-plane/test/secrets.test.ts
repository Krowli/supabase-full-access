import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  decrypt,
  encrypt,
  generatePassword,
  generateProjectSecrets,
  generateRef,
  parseSecretsKey,
  signJwt,
} from '../src/secrets.ts'

const decodePart = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

describe('generateRef', () => {
  it('makes 20 lowercase letters, different each time', () => {
    const refs = new Set(Array.from({ length: 200 }, generateRef))
    expect(refs.size).toBe(200)
    for (const ref of refs) expect(ref).toMatch(/^[a-z]{20}$/)
  })
})

describe('generatePassword', () => {
  it('is alphanumeric with the requested length', () => {
    expect(generatePassword()).toMatch(/^[A-Za-z0-9]{32}$/)
    expect(generatePassword(48)).toHaveLength(48)
  })
})

describe('signJwt', () => {
  it('produces a standard HS256 token', () => {
    const token = signJwt({ role: 'anon' }, 'secret')
    const [head, body, sig] = token.split('.')
    expect(decodePart(head)).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(decodePart(body)).toEqual({ role: 'anon' })
    const expected = createHmac('sha256', 'secret').update(`${head}.${body}`).digest('base64url')
    expect(sig).toBe(expected)
  })

  it('matches a token from a reference implementation (jwt.io example)', () => {
    // The jwt.io HS256 sample: header {"alg":"HS256","typ":"JWT"}, secret "your-256-bit-secret".
    const token = signJwt(
      { sub: '1234567890', name: 'John Doe', iat: 1516239022 },
      'your-256-bit-secret'
    )
    expect(token).toBe(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    )
  })
})

describe('generateProjectSecrets', () => {
  it('signs anon and service_role keys with the project JWT secret and a long expiry', () => {
    const now = new Date('2026-10-12T00:00:00Z')
    const s = generateProjectSecrets('abcdefghijklmnopqrst', now)
    expect(s.db_password).toMatch(/^[A-Za-z0-9]{32}$/)
    expect(s.jwt_secret.length).toBeGreaterThanOrEqual(32)

    for (const [key, role] of [
      [s.anon_key, 'anon'],
      [s.service_key, 'service_role'],
    ]) {
      const [head, body, sig] = key.split('.')
      const payload = decodePart(body)
      expect(payload).toMatchObject({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role })
      expect(payload.iat).toBe(now.getTime() / 1000)
      expect(payload.exp - payload.iat).toBeGreaterThanOrEqual(10 * 365 * 24 * 3600)
      expect(sig).toBe(
        createHmac('sha256', s.jwt_secret).update(`${head}.${body}`).digest('base64url')
      )
    }
  })

  it('gives every project different secrets', () => {
    const a = generateProjectSecrets('aaaaaaaaaaaaaaaaaaaa')
    const b = generateProjectSecrets('aaaaaaaaaaaaaaaaaaaa')
    expect(a.db_password).not.toBe(b.db_password)
    expect(a.jwt_secret).not.toBe(b.jwt_secret)
    expect(a.s3_access_key).not.toBe(b.s3_access_key)
  })

  it('makes MinIO keys within MinIO limits (access key 20, secret key 40)', () => {
    const s = generateProjectSecrets('aaaaaaaaaaaaaaaaaaaa')
    expect(s.s3_access_key).toMatch(/^[A-Z0-9]{20}$/)
    expect(s.s3_secret_key).toMatch(/^[A-Za-z0-9]{40}$/)
  })
})

describe('encryption', () => {
  const key = randomBytes(32)

  it('round-trips', () => {
    const sealed = encrypt('hunter2', key, 'ref:db_password')
    expect(sealed).toMatch(/^v1\./)
    expect(sealed).not.toContain('hunter2')
    expect(decrypt(sealed, key, 'ref:db_password')).toBe('hunter2')
  })

  it('uses a fresh IV, so equal plaintexts differ', () => {
    expect(encrypt('x', key, 'c')).not.toBe(encrypt('x', key, 'c'))
  })

  it('rejects another key, another context and tampering', () => {
    const sealed = encrypt('hunter2', key, 'ref:db_password')
    expect(() => decrypt(sealed, randomBytes(32), 'ref:db_password')).toThrow()
    expect(() => decrypt(sealed, key, 'ref:jwt_secret')).toThrow()
    const parts = sealed.split('.')
    const ct = Buffer.from(parts[3], 'base64url')
    ct[0] ^= 1
    parts[3] = ct.toString('base64url')
    expect(() => decrypt(parts.join('.'), key, 'ref:db_password')).toThrow()
  })

  it('parses the key from hex or base64 and rejects other lengths', () => {
    const raw = randomBytes(32)
    expect(parseSecretsKey(raw.toString('hex')).equals(raw)).toBe(true)
    expect(parseSecretsKey(raw.toString('base64')).equals(raw)).toBe(true)
    expect(() => parseSecretsKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/)
  })
})
