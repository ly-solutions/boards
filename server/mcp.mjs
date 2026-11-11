/**
 * MCP over Streamable HTTP: `POST /mcp` with JSON-RPC 2.0, answered with plain JSON.
 *
 * Stateless: no sessions (`Mcp-Session-Id`) and no SSE stream — every call carries its token, and boards has no
 * long-running operations. `GET` answers 405, which the specification allows for a server without a stream.
 */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

/** An error the agent should read as is: a missing board, a bad argument. */
export class ToolError extends Error {}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })

/**
 * Handle one JSON-RPC message. `tools` is an array of `{ name, title, description, inputSchema, annotations,
 * run(args, ctx) → string }`. A notification (no id) gets no answer.
 */
export async function handleMessage(message, { tools, ctx, serverInfo, instructions, describeError }) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message?.id, -32600, 'expected a JSON-RPC 2.0 request')
  }
  const { id, method, params = {} } = message
  if (id === undefined) return null

  if (method === 'initialize') {
    const asked = params?.protocolVersion
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo,
      instructions,
    })
  }
  if (method === 'ping') return rpcResult(id, {})
  if (method === 'tools/list') {
    return rpcResult(id, { tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) })
  }
  if (method === 'tools/call') {
    const tool = tools.find((t) => t.name === params?.name)
    if (!tool) return rpcError(id, -32602, `no such tool: ${params?.name}`)
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
    try {
      const text = await tool.run(args, ctx)
      return rpcResult(id, { content: [{ type: 'text', text }], isError: false })
    } catch (error) {
      return rpcResult(id, { content: [{ type: 'text', text: describeError(error) }], isError: true })
    }
  }
  return rpcError(id, -32601, `method not supported: ${method}`)
}

/** A POST body: one message or a batch. Returns [status, body | null]. */
export async function handleBody(body, options) {
  const batch = Array.isArray(body)
  const messages = batch ? body : [body]
  if (batch && messages.length === 0) return [400, rpcError(null, -32600, 'empty batch')]
  const responses = (await Promise.all(messages.map((m) => handleMessage(m, options)))).filter(Boolean)
  if (!responses.length) return [202, null]
  return [200, batch ? responses : responses[0]]
}
