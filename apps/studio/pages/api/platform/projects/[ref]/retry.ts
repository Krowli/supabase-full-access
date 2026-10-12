import { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { handleRetryProject } from '@/lib/api/self-hosted/project-lifecycle'

/**
 * Fork: re-runs provisioning of a project whose setup failed, from the dashboard's failed screen
 * (deploy/platform/SPEC.md M6). `apiWrapper` has already answered 404 for a ref the registry does
 * not hold.
 */
const retryProject = (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)
export default retryProject

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'POST':
      return handleRetryProject(req, res)
    default:
      res.setHeader('Allow', ['POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}
