import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DestinationError,
  MAX_RESPONSE_BYTES,
  postJson,
  resolveDestination,
  type Resolved,
} from '../../src/destination.js'
import { SELF_SIGNED_CERT, SELF_SIGNED_KEY } from './self-signed.js'

let server: http.Server
let port: number
const seen: { url: string | undefined; body: string; headers: http.IncomingHttpHeaders }[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      seen.push({ url: req.url, body, headers: req.headers })
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
        return res.end()
      }
      if (req.url === '/429') {
        res.writeHead(429, { 'retry-after': '7' })
        return res.end('slow down')
      }
      if (req.url === '/big') {
        res.writeHead(200)
        return res.end('x'.repeat(5_000_000))
      }
      if (req.url === '/wide') {
        // 6000 bytes, but only 3000 UTF-16 units: a cap that counts units would keep twice what it should
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('é'.repeat(3_000))
      }
      if (req.url === '/split') {
        // the two bytes of one character, in two chunks, and a third character straddling the 2 KB cap
        res.writeHead(200)
        res.write('ok:')
        res.write(Buffer.from([0xc3]))
        res.write(Buffer.from([0xa9]))
        res.write('a'.repeat(2_100))
        return res.end()
      }
      if (req.url === '/cut') {
        // promises 100 bytes, sends 7, then closes cleanly: no error reaches the client, only a short body
        res.writeHead(200, { 'content-length': '100' })
        res.write('partial')
        setTimeout(() => res.socket?.end(), 20)
        return
      }
      if (req.url === '/hang') {
        res.writeHead(200)
        return res.write('a')
      }
      if (req.url === '/drip') {
        // a byte at a time, for ever: never idle, so only an absolute deadline ends this
        res.writeHead(200)
        const tick = setInterval(() => res.write('a'), 50)
        res.on('close', () => clearInterval(tick))
        return
      }
      res.writeHead(204)
      res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as { port: number }).port
})

afterAll(() => {
  server.close()
})

// A Resolved value points at an address the guard has already judged. Building one by hand is the only way a
// test can reach a loopback server, and the next test proves the guard itself still refuses that URL.
const local = (path: string): Resolved => ({
  url: new URL(`http://127.0.0.1:${port}${path}`),
  host: '127.0.0.1',
  address: '127.0.0.1',
  family: 4,
  port,
})

describe('postJson', () => {
  it('sends the body and the headers it was given, to the pinned address', async () => {
    const answer = await postJson(local('/hook'), '{"a":1}', { 'x-blockwarden-signature': 't=1,v1=ab' })
    expect(answer.statusCode).toBe(204)
    expect(answer.remoteAddress).toBe('127.0.0.1')
    const last = seen.at(-1)!
    expect(last.body).toBe('{"a":1}')
    expect(last.headers['x-blockwarden-signature']).toBe('t=1,v1=ab')
    expect(last.headers['content-type']).toBe('application/json')
    expect(last.headers['user-agent']).toBe('Blockwarden/1')
  })

  it('will not let a caller-named header displace the ones it computes', async () => {
    const answer = await postJson(local('/hook'), '{"a":1}', {
      host: 'evil.example.com',
      'Content-Type': 'text/plain',
      'content-length': '9999',
      'User-Agent': 'curl/8',
    })
    expect(answer.statusCode).toBe(204)
    const last = seen.at(-1)!
    expect(last.headers.host).toBe(`127.0.0.1:${port}`)
    expect(last.headers['content-type']).toBe('application/json')
    expect(last.headers['content-length']).toBe('7')
    expect(last.headers['user-agent']).toBe('Blockwarden/1')
    expect(last.body).toBe('{"a":1}')
  })

  it('does not follow a redirect', async () => {
    const answer = await postJson(local('/redirect'), '{}', {})
    expect(answer.statusCode).toBe(302)
    expect(seen.filter((s) => s.url === '/latest/meta-data/')).toHaveLength(0)
  })

  it('reads retry-after from a 429', async () => {
    expect((await postJson(local('/429'), '{}', {})).retryAfterSeconds).toBe(7)
  })

  it('keeps at most 2 KB of the answer', async () => {
    expect((await postJson(local('/big'), '{}', {})).body).toHaveLength(2048)
  })

  it('counts the cap in bytes, not in characters', async () => {
    const answer = await postJson(local('/wide'), '{}', {})
    expect(Buffer.byteLength(answer.body)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES)
    expect(answer.body).toBe('é'.repeat(1_024))
  })

  it('decodes whole characters, at a chunk boundary and at the cap', async () => {
    const answer = await postJson(local('/split'), '{}', {})
    expect(answer.body.startsWith('ok:é')).toBe(true)
    expect(answer.body).not.toContain('�')
    expect(Buffer.byteLength(answer.body)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES)
  })

  it('refuses an answer the destination cut short, rather than reporting it delivered', async () => {
    await expect(postJson(local('/cut'), '{}', {})).rejects.toThrow('before the answer was complete')
  })

  // the deadline is far away, so only the idle timeout can end this one
  it('gives up on a destination that goes silent', async () => {
    await expect(postJson(local('/hang'), '{}', {}, { timeoutMs: 500, deadlineMs: 60_000 })).rejects.toThrow(
      'did not answer in time',
    )
  })

  // a byte every 50 ms keeps the socket busy for ever, so only the deadline ends this one
  it('gives up at the deadline on a destination that dribbles for ever', async () => {
    const started = Date.now()
    await expect(postJson(local('/drip'), '{}', {}, { timeoutMs: 5_000, deadlineMs: 700 })).rejects.toThrow(
      'took longer than the deadline',
    )
    expect(Date.now() - started).toBeLessThan(3_000)
  }, 10_000)
})

describe('over TLS', () => {
  let secureServer: https.Server
  let securePort: number
  const sni: string[] = []
  const peers: (string | undefined)[] = []

  beforeAll(async () => {
    secureServer = https.createServer(
      {
        key: SELF_SIGNED_KEY,
        cert: SELF_SIGNED_CERT,
        SNICallback: (name, cb) => {
          sni.push(name)
          cb(null, undefined)
        },
      },
      (req, res) => {
        peers.push(req.socket.remoteAddress)
        seen.push({ url: req.url, body: '', headers: req.headers })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      },
    )
    secureServer.listen(0, '127.0.0.1')
    await once(secureServer, 'listening')
    securePort = (secureServer.address() as { port: number }).port
  })

  afterAll(() => {
    secureServer.close()
  })

  // pinned.invalid never resolves, so a request that arrives did so through the pinned lookup, on the https path
  const pinned = (): Resolved => ({
    url: new URL(`https://pinned.invalid:${securePort}/hook`),
    host: 'pinned.invalid',
    address: '127.0.0.1',
    family: 4,
    port: securePort,
  })

  it('refuses a certificate it has no reason to trust', async () => {
    const thrown = await postJson(pinned(), '{}', {}).catch((e: NodeJS.ErrnoException) => e)
    expect((thrown as NodeJS.ErrnoException).code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
    // it still got that far over TLS, at the pinned address, with the name in the handshake
    expect(sni.at(-1)).toBe('pinned.invalid')
  })

  it('reaches the pinned address over TLS and reads the answer', async () => {
    // the certificate is checked against the name, so this machine has to trust the test certificate for the
    // request to complete. Nothing in the guard changes: postJson has no option that would skip the check.
    const createSecureContext = tls.createSecureContext
    tls.createSecureContext = (options = {}) => createSecureContext({ ...options, ca: SELF_SIGNED_CERT })
    try {
      const answer = await postJson(pinned(), '{"a":1}', { 'x-blockwarden-signature': 't=1,v1=ab' })
      expect(answer.statusCode).toBe(200)
      expect(answer.body).toBe('{"ok":true}')
      expect(answer.remoteAddress).toBe('127.0.0.1')
      expect(peers.at(-1)).toBe('127.0.0.1')
      expect(sni.at(-1)).toBe('pinned.invalid')
      expect(seen.at(-1)!.headers.host).toBe(`pinned.invalid:${securePort}`)
      expect(seen.at(-1)!.headers['x-blockwarden-signature']).toBe('t=1,v1=ab')
    } finally {
      tls.createSecureContext = createSecureContext
    }
  })
})

describe('the guard and the socket together', () => {
  it('refuses the same loopback URL the test server is on', async () => {
    await expect(resolveDestination(`https://127.0.0.1:${port}/hook`)).rejects.toBeInstanceOf(DestinationError)
  })

  it('refuses a name that resolves to loopback, through the real resolver', async () => {
    // localhost resolves to 127.0.0.1 and ::1 on every machine this runs on
    await expect(resolveDestination(`https://localhost:${port}/hook`)).rejects.toThrow(/127\.0\.0\.0\/8|::\/64/)
  })

  it('asks the resolver once, so a rebinding second answer is never seen', async () => {
    let calls = 0
    const rebinding = async () => {
      calls++
      return calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]
    }
    const target = await resolveDestination('https://rebind.example.com/hook', rebinding)
    expect(target.address).toBe('93.184.216.34')
    expect(calls).toBe(1)
  })

  it('connects to the pinned address even when the host name resolves to nothing', async () => {
    // .invalid never resolves, so the only way this request can arrive is through the pinned lookup
    const target: Resolved = {
      url: new URL(`http://does-not-exist.invalid:${port}/hook`),
      host: 'does-not-exist.invalid',
      address: '127.0.0.1',
      family: 4,
      port,
    }
    const answer = await postJson(target, '{}', {})
    expect(answer.statusCode).toBe(204)
    expect(answer.remoteAddress).toBe('127.0.0.1')
    expect(seen.at(-1)!.headers.host).toBe(`does-not-exist.invalid:${port}`)
  })
})
