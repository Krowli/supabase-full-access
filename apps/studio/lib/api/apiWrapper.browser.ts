import { ResponseError, ResponseFailure } from '@/types'

// Fork: lives apart from apiWrapper.ts, which pulls in the server-only project resolver
// (node:async_hooks), so client code such as lib/integration-utils.ts can import it.
export function isResponseOk<T>(response: T | ResponseFailure | undefined): response is T {
  if (response === undefined || response === null) {
    return false
  }

  if (response instanceof ResponseError) {
    return false
  }

  if (typeof response === 'object' && 'error' in response && Boolean(response.error)) {
    return false
  }

  return true
}
