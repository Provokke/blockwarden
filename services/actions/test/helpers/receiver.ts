import http from 'node:http'
import { once } from 'node:events'

export type Received = { path: string; body: string; headers: http.IncomingHttpHeaders }

// a destination that answers however the test says, and keeps everything it was sent
export async function startReceiver() {
  const received: Received[] = []
  let status = 204
  const server = http.createServer((req, res) => {
    let body = ''
    // decode as chunks arrive: += on Buffers would decode each on its own and mangle a split
    // multi-byte character
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
    // one receiver serves every destination the test resolves to it; the path says which
    urlFor(path: string) {
      return `http://127.0.0.1:${port}${path}`
    },
    async stop() {
      server.close()
      await once(server, 'close')
    },
  }
}
