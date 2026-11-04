import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { selfHostedSupabaseAdmin as supabase } from '@/lib/api/self-hosted-admin'

/**
 * Fork: a bucket's lifecycle policy (FORK.md, object versioning). storage-api keeps it under
 * `/bucket/:id/lifecycle` with camelCase fields; the platform's contract is snake_case, so both
 * directions are mapped here. storage-api stores the rules but nothing in it applies them, which
 * the bucket settings say self-hosted.
 */

type LifecycleBody = components['schemas']['UpdateBucketLifecycleBody']
type LifecycleResponse = components['schemas']['BucketLifecycleResponse_Output']
type BucketLifecycleConfiguration = Parameters<typeof supabase.storage.updateBucketLifecycle>[1]

export default function lifecycle(req: NextApiRequest, res: NextApiResponse) {
  return apiWrapper(req, res, handler)
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res)
    case 'PUT':
      return handlePut(req, res)
    case 'DELETE':
      return handleDelete(req, res)
    default:
      res.setHeader('Allow', ['GET', 'PUT', 'DELETE'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse) => {
  const { id } = req.query

  const { data, error } = await supabase.storage.getBucketLifecycle(id as string)
  if (error) return sendError(res, error)

  return res.status(200).json(toResponse(data))
}

const handlePut = async (req: NextApiRequest, res: NextApiResponse) => {
  const { id } = req.query
  const { rules } = (req.body ?? {}) as Partial<LifecycleBody>
  if (!Array.isArray(rules)) {
    return res.status(400).json({ error: { message: 'rules must be an array' } })
  }

  const configuration: BucketLifecycleConfiguration = {
    rules: rules.map((rule) => ({
      ...(rule.id ? { id: rule.id } : {}),
      status: rule.status,
      filter: rule.filter,
      noncurrentVersionExpiration: {
        noncurrentDays: rule.noncurrent_version_expiration?.noncurrent_days,
        ...(rule.noncurrent_version_expiration?.newer_noncurrent_versions !== undefined
          ? {
              newerNoncurrentVersions: rule.noncurrent_version_expiration.newer_noncurrent_versions,
            }
          : {}),
      },
    })),
  }

  const { data, error } = await supabase.storage.updateBucketLifecycle(id as string, configuration)
  if (error) return sendError(res, error)

  return res.status(200).json(toResponse(data))
}

const handleDelete = async (req: NextApiRequest, res: NextApiResponse) => {
  const { id } = req.query

  const { data, error } = await supabase.storage.deleteBucketLifecycle(id as string)
  if (error) return sendError(res, error)

  return res.status(200).json(data)
}

const toResponse = (configuration: BucketLifecycleConfiguration): LifecycleResponse => ({
  rules: (configuration.rules ?? []).map((rule) => ({
    ...(rule.id ? { id: rule.id } : {}),
    status: rule.status,
    filter: rule.filter,
    ...(rule.noncurrentVersionExpiration
      ? {
          noncurrent_version_expiration: {
            noncurrent_days: rule.noncurrentVersionExpiration.noncurrentDays,
            ...(rule.noncurrentVersionExpiration.newerNoncurrentVersions !== undefined
              ? {
                  newer_noncurrent_versions:
                    rule.noncurrentVersionExpiration.newerNoncurrentVersions,
                }
              : {}),
          },
        }
      : {}),
  })),
})

/**
 * storage-api answers HTTP 400 with the real status in the body's `statusCode` (`"404"` for
 * NoSuchLifecycleConfiguration, `"409"` for FeatureNotEnabled). The client reads a 404 as "no
 * policy", so that status is passed on; anything that is not a 4xx becomes a 400.
 */
const sendError = (res: NextApiResponse, error: { message: string; statusCode?: string }) => {
  const status = Number(error.statusCode)
  return res
    .status(status >= 400 && status < 500 ? status : 400)
    .json({ error: { message: error.message } })
}
