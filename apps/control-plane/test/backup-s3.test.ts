import { describe, expect, it } from 'vitest'

import { expiryOf, signV4 } from '../src/backup/s3.ts'

describe('signV4', () => {
  // AWS's worked example "GET Object" (Signature Version 4, header-based authentication).
  it('matches the AWS example signature', () => {
    const headers = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      now: new Date('2013-05-24T00:00:00Z'),
    })
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    )
  })
})

describe('expiryOf', () => {
  it('reads the rule that will delete an object', () => {
    expect(expiryOf('expiry-date="Wed, 11 Nov 2026 09:39:57 GMT", rule-id="delete-after-30-days"')).toBe(
      'delete-after-30-days'
    )
    expect(expiryOf(null)).toBeNull()
  })
})
