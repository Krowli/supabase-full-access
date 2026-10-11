import { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { DEFAULT_ORG_SLUG, organizationProjectsResponse } from '@/lib/api/self-hosted/project-list'

/**
 * Fork: the organization's projects, which the header's project switcher lists
 * (deploy/platform/SPEC.md §2.1). Self-hosted has one organization, and every project in the
 * registry belongs to it.
 */
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

const handleGet = async (req: NextApiRequest, res: NextApiResponse) => {
  const { slug } = req.query
  if (slug !== DEFAULT_ORG_SLUG) {
    return res.status(404).json({ error: { message: `Organization ${slug} not found` } })
  }
  return res.status(200).json(await organizationProjectsResponse(req.query))
}
