import { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { countNotebooks } from '@/lib/api/self-hosted/notebooks'
import { getSnippets } from '@/lib/api/snippets.utils'

const wrappedHandler = (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

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

type GetRequestData = paths['/platform/projects/{ref}/content/count']['get']['parameters']['query']

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  const params = req.query as GetRequestData

  try {
    // Notebooks are all shared with the project, none private — the shape Explorer reads.
    if (params?.type === 'notebook') {
      const count = await countNotebooks(params.name)
      if (params.name) return res.status(200).json({ count })
      return res.status(200).json({ shared: count, favorites: 0, private: 0 })
    }

    const { snippets } = await getSnippets({
      searchTerm: params?.name,
      includeContent: false,
    })
    if (params?.name) {
      return res.status(200).json({
        count: snippets.length,
      })
    } else {
      return res.status(200).json({
        shared: snippets.filter((s) => s.visibility === 'project').length,
        favorites: snippets.filter((s) => s.favorite).length,
        private: snippets.filter((s) => s.visibility === 'user').length,
      })
    }
  } catch (error: any) {
    console.error('Error fetching snippets:', error)
    return res.status(500).json({ message: error?.message ?? 'Failed to get count' })
  }
}

export default wrappedHandler
