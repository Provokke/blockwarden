import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// What the scripted node does with one JSON-RPC call: answer with a result or an error, or never answer.
export type MockReply =
  | { result: unknown; status?: number }
  | { error: { code: number; message: string; data?: string }; status?: number }
  | { status: number; text: string }
  | 'hang'

export type MockRpc = Awaited<ReturnType<typeof startMockRpc>>

// A tiny JSON-RPC node over real HTTP, so errors reach the chain client through viem's own transport and wrapping.
export async function startMockRpc(reply: (method: string) => MockReply) {
  const calls: string[] = []
  const hanging: ServerResponse[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string }
      calls.push(method)
      const answer = reply(method)
      if (answer === 'hang') {
        hanging.push(res)
        return
      }
      if ('text' in answer) {
        res.writeHead(answer.status, { 'content-type': 'text/plain' }).end(answer.text)
        return
      }
      const { status = 200, ...payload } = answer
      res
        .writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    async stop(): Promise<void> {
      for (const res of hanging) res.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

// a URL nothing listens on: bind a port, then let it go
export async function deadUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}
