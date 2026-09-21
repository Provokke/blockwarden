import http from 'node:http'
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DestinationError, postJson, resolveDestination, type Resolved } from '../../src/destination.js'

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
      if (req.url === '/hang') {
        res.writeHead(200)
        return res.write('a')
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

  it('gives up on a destination that never finishes', async () => {
    await expect(postJson(local('/hang'), '{}', {}, { timeoutMs: 500 })).rejects.toThrow('did not answer in time')
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
