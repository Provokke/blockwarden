import http from 'node:http'
import { once } from 'node:events'

export type Received = { path: string; body: string; headers: http.IncomingHttpHeaders }

// a destination that answers however the test tells it to, and keeps everything it was sent
export async function startReceiver() {
  const received: Received[] = []
  let status = 204
  const server = http.createServer((req, res) => {
    let body = ''
    // decode as the chunks arrive: concatenating Buffers through += would decode each one on its own, and a
    // multi-byte character split across two of them would come out mangled and fail its signature
    req.setEncoding('utf8')
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      received.push({ path: req.url ?? '', body, headers: req.headers })
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
    // one receiver serves every destination the test resolves to it; the path is how a delivery says which
    urlFor(path: string) {
      return `http://127.0.0.1:${port}${path}`
    },
    async stop() {
      server.close()
      await once(server, 'close')
    },
  }
}
