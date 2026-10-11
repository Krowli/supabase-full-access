import { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { currentProjectStatus } from '@/lib/api/self-hosted/project-context'

/**
 * Fork: the project's status, which the building screen polls until it reads `ACTIVE_HEALTHY`
 * (deploy/platform/SPEC.md §2.1). `apiWrapper` has already answered 404 for a ref the registry
 * does not hold.
 */
const projectStatus = (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)
export default projectStatus

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return res.status(200).json({ status: currentProjectStatus() })
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}
