// Reproduces CloudFront in production: one origin that serves the site and forwards /v1/* to the API. Open http://localhost:3100, not the next dev server directly.
// A Secure cookie works over http://localhost (browsers treat it as a secure context) but not over http://192.168.1.10, which is why this binds localhost only.
// Running next dev on 3000 and calling the API on 3200 directly looks fine until login: the
// Set-Cookie is accepted for localhost:3200 and the next request from 3000 carries nothing.
// Ports come from the environment so a test can use free ones.
import { request } from 'node:http'
import { createServer } from 'node:http'
import { connect } from 'node:net'

function port(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} is not a port: ${raw}`)
  return value
}

const PROXY_PORT = port('PROXY_PORT', 3100)
const API_PORT = port('API_PORT', 3200)
const NEXT_PORT = port('NEXT_PORT', 3000)

// '/v1' or '/v1/...' and nothing else: /v1x is a page, not an API route
function isApi(url) {
  return /^\/v1(?:[/?]|$)/.test(url ?? '')
}

const server = createServer((req, res) => {
  const upstreamPort = isApi(req.url) ? API_PORT : NEXT_PORT
  const upstream = request(
    {
      host: 'localhost',
      port: upstreamPort,
      method: req.method,
      path: req.url,
      // the browser's host names the proxy; tell the upstream where the request really came in
      headers: { ...req.headers, host: `localhost:${upstreamPort}`, 'x-forwarded-host': req.headers.host ?? '' },
    },
    (upstreamRes) => {
      // rawHeaders would keep duplicates but headers already holds set-cookie as an array, which
      // writeHead emits as one line per cookie
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', (err) => {
    if (res.headersSent) return res.destroy()
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`upstream on ${upstreamPort} is not reachable: ${err.code ?? 'error'}`)
  })
  req.pipe(upstream)
})

// next dev hot reload runs over a websocket; without this the page loads but never refreshes
server.on('upgrade', (req, socket, head) => {
  const upstream = connect(NEXT_PORT, 'localhost', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(PROXY_PORT, 'localhost', () => {
  console.log(`dev proxy listening on http://localhost:${PROXY_PORT} (api :${API_PORT}, next :${NEXT_PORT})`)
})
