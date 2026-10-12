import { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { handleProjectBackups } from '@/lib/api/self-hosted/project-backups'

/**
 * Fork: restores one backup into a new project next to this one (deploy/platform/SPEC.md §19).
 * Body: `{ snapshot_id, name }`. This project is never written to.
 */
const restoreBackup = (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)
export default restoreBackup

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  return handleProjectBackups(res, { action: 'restore', body: req.body ?? {} })
}
