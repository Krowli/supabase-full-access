import { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { handleProjectBackups } from '@/lib/api/self-hosted/project-backups'

/**
 * Fork: the project's backups (GET) and "Back up now" (POST), from the platform's backup service
 * (deploy/platform/SPEC.md §19). `apiWrapper` has already answered 404 for a ref the registry does
 * not hold.
 */
const projectBackups = (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)
export default projectBackups

async function handler(req: NextApiRequest, res: NextApiResponse) {
  switch (req.method) {
    case 'GET':
      return handleProjectBackups(res, { action: 'view' })
    case 'POST':
      return handleProjectBackups(res, { action: 'run' })
    default:
      res.setHeader('Allow', ['GET', 'POST'])
      res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
}
