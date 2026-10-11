import { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { isMultiProject } from '@/lib/api/self-hosted/project-context'
import { listProjectsResponse, platformProjects } from '@/lib/api/self-hosted/project-list'
import { DEFAULT_PROJECT } from '@/lib/constants/api'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  // Fork: every registry project, paged for `Version: 2` callers (deploy/platform/SPEC.md M2)
  if (req.headers.version === '2')
    return res.status(200).json(await listProjectsResponse(req.query))
  if (isMultiProject()) return res.status(200).json(await platformProjects())
  // Platform specific endpoint
  const response = [DEFAULT_PROJECT]
  return res.status(200).json(response)
}
