import { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'

type ValidateSpamBody = components['schemas']['ValidateSpamBody']
type ValidateSpamResponse = components['schemas']['ValidateSpamResponse_Output']

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'POST':
      return handlePost(req, res)
    default:
      res.setHeader('Allow', ['POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

/**
 * Scores an email template for spam, which self-hosted nothing can do: the platform runs the
 * subject and body through SpamAssassin, and there is no SpamAssassin here.
 *
 * An empty rule list is the right answer rather than a 404 or a 501, because the template editor
 * calls this before every save and refuses to save while any rule with a score above zero stands
 * (`SpamValidation.tsx`). Failing the call would leave the editor unable to save at all.
 */
const handlePost = async (req: NextApiRequest, res: NextApiResponse) => {
  const body: unknown = req.body

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return res
      .status(400)
      .json({ error: { message: 'Body must be an object with a subject and content' } })
  }

  const { subject, content } = body as Partial<ValidateSpamBody>
  if (typeof subject !== 'string' || typeof content !== 'string') {
    return res.status(400).json({ error: { message: 'subject and content must both be strings' } })
  }

  const response: ValidateSpamResponse = { rules: [] }
  return res.status(200).json(response)
}
