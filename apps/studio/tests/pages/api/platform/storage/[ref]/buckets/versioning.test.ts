import { createMocks, type RequestMethod } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import bucketHandler from '../../../../../../../pages/api/platform/storage/[ref]/buckets/[id]'
import lifecycleHandler from '../../../../../../../pages/api/platform/storage/[ref]/buckets/[id]/lifecycle'
import moveHandler from '../../../../../../../pages/api/platform/storage/[ref]/buckets/[id]/objects/move'
import publicUrlHandler from '../../../../../../../pages/api/platform/storage/[ref]/buckets/[id]/objects/public-url'
import signHandler from '../../../../../../../pages/api/platform/storage/[ref]/buckets/[id]/objects/sign'
import bucketsHandler from '../../../../../../../pages/api/platform/storage/[ref]/buckets/index'

/**
 * Fork: object versioning self-hosted (FORK.md). The handlers pass the versioning fields through to
 * storage-api and map the lifecycle policy between the platform's snake_case and storage-js.
 */

vi.mock('@/lib/constants', () => ({
  IS_PLATFORM: false,
  API_URL: 'https://api.example.com',
}))

const storage = vi.hoisted(() => {
  const bucket = {
    move: vi.fn(),
    createSignedUrl: vi.fn(),
    getPublicUrl: vi.fn(),
  }
  return {
    bucket,
    createBucket: vi.fn(),
    updateBucket: vi.fn(),
    getBucketLifecycle: vi.fn(),
    updateBucketLifecycle: vi.fn(),
    deleteBucketLifecycle: vi.fn(),
    from: vi.fn(() => bucket),
  }
})

vi.mock('@/lib/api/self-hosted-admin', () => ({
  selfHostedSupabaseAdmin: { storage },
}))

type Handler = (req: never, res: never) => Promise<unknown> | unknown

const call = async (
  handler: Handler,
  method: RequestMethod,
  body?: object,
  query: Record<string, string> = { ref: 'default', id: 'docs' }
) => {
  const { req, res } = createMocks({ method, query, body })
  await handler(req as never, res as never)
  return res
}

const storageError = (statusCode: string, message: string) => ({
  data: null,
  error: { message, statusCode },
})

describe('object versioning, self-hosted storage handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('SUPABASE_PUBLIC_URL', 'https://studio.example.com')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('POST /buckets', () => {
    it('passes ENABLED on to storage-api', async () => {
      storage.createBucket.mockResolvedValue({ data: { name: 'docs' }, error: null })

      const res = await call(bucketsHandler, 'POST', {
        id: 'docs',
        public: false,
        versioning_status: 'ENABLED',
      })

      expect(res._getStatusCode()).toBe(200)
      expect(storage.createBucket).toHaveBeenCalledWith(
        'docs',
        expect.objectContaining({ versioningStatus: 'ENABLED' })
      )
    })

    it('leaves DISABLED out, so a create works on a storage-api without versioning', async () => {
      storage.createBucket.mockResolvedValue({ data: { name: 'docs' }, error: null })

      await call(bucketsHandler, 'POST', {
        id: 'docs',
        public: false,
        versioning_status: 'DISABLED',
      })

      expect(storage.createBucket.mock.calls[0][1]).not.toHaveProperty('versioningStatus')
    })
  })

  describe('PATCH /buckets/:id', () => {
    it('passes a status change on', async () => {
      storage.updateBucket.mockResolvedValue({ data: { message: 'ok' }, error: null })

      await call(bucketHandler, 'PATCH', { public: false, versioning_status: 'SUSPENDED' })

      expect(storage.updateBucket).toHaveBeenCalledWith(
        'docs',
        expect.objectContaining({ versioningStatus: 'SUSPENDED' })
      )
    })

    it('sends no status when the body has none', async () => {
      storage.updateBucket.mockResolvedValue({ data: { message: 'ok' }, error: null })

      await call(bucketHandler, 'PATCH', { public: true })

      expect(storage.updateBucket.mock.calls[0][1]).not.toHaveProperty('versioningStatus')
    })
  })

  describe('objects', () => {
    it('restores a version through move with sourceVersionId', async () => {
      storage.bucket.move.mockResolvedValue({
        data: { message: 'Successfully moved' },
        error: null,
      })

      await call(moveHandler, 'POST', { from: 'a.txt', to: 'a.txt', sourceVersionId: 'v1' })

      expect(storage.bucket.move).toHaveBeenCalledWith('a.txt', 'a.txt', { sourceVersionId: 'v1' })
    })

    it('moves as before without a version', async () => {
      storage.bucket.move.mockResolvedValue({
        data: { message: 'Successfully moved' },
        error: null,
      })

      await call(moveHandler, 'POST', { from: 'a.txt', to: 'b.txt' })

      expect(storage.bucket.move).toHaveBeenCalledWith('a.txt', 'b.txt', undefined)
    })

    it('signs a version, and only passes its id on', async () => {
      storage.bucket.createSignedUrl.mockResolvedValue({
        data: { signedUrl: 'http://kong:8000/storage/v1/object/sign/docs/a.txt?token=t' },
        error: null,
      })

      const res = await call(signHandler, 'POST', {
        path: 'a.txt',
        expiresIn: 60,
        options: { versionId: 'v1', transform: { width: 10 } },
      })

      expect(storage.bucket.createSignedUrl).toHaveBeenCalledWith('a.txt', 60, { versionId: 'v1' })
      expect(res._getJSONData().signedUrl).toMatch(/^https:\/\/studio\.example\.com\//)
    })

    it('gives the public URL of a version', async () => {
      storage.bucket.getPublicUrl.mockReturnValue({
        data: { publicUrl: 'http://kong:8000/storage/v1/object/public/docs/a.txt?versionId=v1' },
      })

      await call(publicUrlHandler, 'POST', { path: 'a.txt', options: { versionId: 'v1' } })

      expect(storage.bucket.getPublicUrl).toHaveBeenCalledWith('a.txt', { versionId: 'v1' })
    })
  })

  describe('/buckets/:id/lifecycle', () => {
    const camel = {
      rules: [
        {
          id: 'rule-1',
          status: 'Enabled',
          filter: {},
          noncurrentVersionExpiration: { noncurrentDays: 30, newerNoncurrentVersions: 2 },
        },
      ],
    }
    const snake = {
      rules: [
        {
          id: 'rule-1',
          status: 'Enabled',
          filter: {},
          noncurrent_version_expiration: { noncurrent_days: 30, newer_noncurrent_versions: 2 },
        },
      ],
    }

    it('answers the policy in the platform shape', async () => {
      storage.getBucketLifecycle.mockResolvedValue({ data: camel, error: null })

      const res = await call(lifecycleHandler, 'GET')

      expect(res._getStatusCode()).toBe(200)
      expect(res._getJSONData()).toEqual(snake)
    })

    it('answers 404 when the bucket has no policy, which the client reads as none', async () => {
      storage.getBucketLifecycle.mockResolvedValue(
        storageError('404', 'The lifecycle configuration does not exist')
      )

      const res = await call(lifecycleHandler, 'GET')

      expect(res._getStatusCode()).toBe(404)
    })

    it('maps a PUT to storage-js and back', async () => {
      storage.updateBucketLifecycle.mockResolvedValue({ data: camel, error: null })

      const res = await call(lifecycleHandler, 'PUT', {
        rules: [
          {
            status: 'Enabled',
            filter: {},
            noncurrent_version_expiration: { noncurrent_days: 30, newer_noncurrent_versions: 2 },
          },
        ],
      })

      expect(storage.updateBucketLifecycle).toHaveBeenCalledWith('docs', {
        rules: [
          {
            status: 'Enabled',
            filter: {},
            noncurrentVersionExpiration: { noncurrentDays: 30, newerNoncurrentVersions: 2 },
          },
        ],
      })
      expect(res._getJSONData()).toEqual(snake)
    })

    it('passes FeatureNotEnabled on as 409', async () => {
      storage.updateBucketLifecycle.mockResolvedValue(storageError('409', 'Feature not enabled'))

      const res = await call(lifecycleHandler, 'PUT', { rules: snake.rules })

      expect(res._getStatusCode()).toBe(409)
      expect(res._getJSONData()).toEqual({ error: { message: 'Feature not enabled' } })
    })

    it('refuses a body without rules', async () => {
      const res = await call(lifecycleHandler, 'PUT', {})

      expect(res._getStatusCode()).toBe(400)
      expect(storage.updateBucketLifecycle).not.toHaveBeenCalled()
    })

    it('deletes the policy', async () => {
      storage.deleteBucketLifecycle.mockResolvedValue({
        data: { message: 'Successfully deleted' },
        error: null,
      })

      const res = await call(lifecycleHandler, 'DELETE')

      expect(storage.deleteBucketLifecycle).toHaveBeenCalledWith('docs')
      expect(res._getStatusCode()).toBe(200)
    })

    it('answers 405 for other methods', async () => {
      const res = await call(lifecycleHandler, 'POST', {})

      expect(res._getStatusCode()).toBe(405)
    })
  })
})
