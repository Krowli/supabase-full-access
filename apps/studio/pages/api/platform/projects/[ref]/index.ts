import { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { applyProjectDetail } from '@/lib/api/self-hosted/multi-project'
import { isMultiProject } from '@/lib/api/self-hosted/project-context'
import { DEFAULT_PROJECT, PROJECT_REST_URL } from '@/lib/constants/api'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (_req: NextApiRequest, res: NextApiResponse) => {
  // Platform specific endpoint
  const response = {
    ...DEFAULT_PROJECT,
    connectionString: '',
    restUrl: PROJECT_REST_URL,
  }
  if (isMultiProject()) applyProjectDetail(response) // Fork: per-project detail

  return res.status(200).json(response)
}
