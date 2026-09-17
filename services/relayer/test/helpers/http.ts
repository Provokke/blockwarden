import { createServer, type Server } from 'node:http'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { ROUTES, type ApiHandler } from '../../src/api.js'

// Plays API Gateway for the client tests: matches the three routes, builds a version 2.0 event and writes the
// handler's result back. Only the fields the handler reads are filled in.
export async function serveApi(handler: ApiHandler): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', async () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      const txMatch = /^\/v1\/relayer\/txs\/([^/]+)$/.exec(path)
      let routeKey = '$default'
      let pathParameters: Record<string, string> | undefined
      if (req.method === 'POST' && path === '/v1/relayer/txs') routeKey = ROUTES.submit
      else if (req.method === 'GET' && path === '/v1/relayer/signers') routeKey = ROUTES.signers
      else if (req.method === 'GET' && txMatch) {
        routeKey = ROUTES.getTx
        pathParameters = { txId: decodeURIComponent(txMatch[1]!) }
      }
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v ?? '')]),
      )
      const body = Buffer.concat(chunks).toString('utf8')
      const event = {
        routeKey,
        rawPath: path,
        headers,
        pathParameters,
        body: body || undefined,
        isBase64Encoded: false,
      } as unknown as APIGatewayProxyEventV2
      const result = await handler(event)
      res.writeHead(result.statusCode ?? 200, result.headers as Record<string, string>)
      res.end(result.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the API test server did not bind a port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      }),
  }
}
