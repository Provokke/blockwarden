import http from 'node:http'
import { once } from 'node:events'

export type Received = { body: string; headers: http.IncomingHttpHeaders }

// a destination that answers however the test tells it to, and keeps everything it was sent
export async function startReceiver() {
  const received: Received[] = []
  let status = 204
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      received.push({ body, headers: req.headers })
      res.writeHead(status)
      res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  return {
    port,
    received,
    answerWith(next: number) {
      status = next
    },
    url: `http://127.0.0.1:${port}/hook`,
    async stop() {
      server.close()
      await once(server, 'close')
    },
  }
}
