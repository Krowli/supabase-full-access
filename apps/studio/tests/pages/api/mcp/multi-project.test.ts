import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import handler from '../../../../pages/api/mcp/index'

/**
 * Fork: the self-hosted MCP server has no project in its URL and always served `default`. With a
 * project registry it refuses instead (deploy/platform/SPEC.md, M2/M3 status), so an MCP client
 * can never be pointed at one project's database while believing it has another.
 */

const { createSupabaseMcpServer } = vi.hoisted(() => ({
  createSupabaseMcpServer: vi.fn().mockReturnValue({
    connect: vi.fn().mockResolvedValue(undefined),
  }),
}))

// The same mocks as index.test.ts, for the same reason: node-mocks-http cannot drive the SDK.
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: vi.fn().mockImplementation(function () {
    return { handleRequest: vi.fn().mockResolvedValue(undefined) }
  }),
}))

vi.mock('@supabase/mcp-server-supabase', () => ({ createSupabaseMcpServer }))

afterEach(() => {
  vi.unstubAllEnvs()
  createSupabaseMcpServer.mockClear()
})

describe('/api/mcp with a project registry', () => {
  it.each([
    ['STUDIO_PROJECT_REGISTRY', '/data/registry.json'],
    ['STUDIO_PROJECT_REGISTRY_URL', 'http://control-plane:8080'],
  ])('refuses to start an MCP server when %s is set', async (name, value) => {
    vi.stubEnv(name, value)
    const { req, res } = createMocks({ method: 'POST', query: {}, body: {} })

    await handler(req, res)

    expect(res._getStatusCode()).toBe(501)
    expect(res._getJSONData()).toEqual({
      error: {
        message:
          'The MCP server is not available when Studio serves several projects: it cannot tell which project a client means',
      },
    })
    expect(createSupabaseMcpServer).not.toHaveBeenCalled()
  })

  it('serves default as before without one', async () => {
    vi.stubEnv('STUDIO_PROJECT_REGISTRY', undefined)
    vi.stubEnv('STUDIO_PROJECT_REGISTRY_URL', undefined)
    const { req, res } = createMocks({ method: 'POST', query: {}, body: {} })

    await handler(req, res)

    expect(createSupabaseMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'default' })
    )
  })
})
