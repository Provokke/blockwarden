// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type Seen = { url: string; method: string; headers: IncomingHttpHeaders; body: string }

let api: Server
let next: Server
let proxy: ChildProcess
let base: string
const apiSeen: Seen[] = []
const nextSeen: Seen[] = []

// the probes stay open until every port is handed out, so no two calls can be given the same one
async function freePorts(count: number): Promise<number[]> {
  const probes = await Promise.all(
    Array.from({ length: count }, () => {
      const probe = createServer()
      return new Promise<Server>((resolve) => probe.listen(0, '127.0.0.1', () => resolve(probe)))
    }),
  )
  const ports = probes.map((probe) => (probe.address() as AddressInfo).port)
  await Promise.all(probes.map((probe) => new Promise((resolve) => probe.close(resolve))))
  return ports
}

const PROXY_SCRIPT = fileURLToPath(new URL('../scripts/dev-proxy.mjs', import.meta.url))

// resolves once the proxy says it is listening, and rejects if it exits first so a crash is not a timeout
function startProxy(env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`dev proxy exited with ${code}`)))
    child.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('listening')) resolve(child)
    })
  })
}

function stub(sink: Seen[], label: string, respond: (seen: Seen, res: ServerResponse) => void): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const seen = {
        url: req.url ?? '',
        method: req.method ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      }
      sink.push(seen)
      res.setHeader('x-upstream', label)
      respond(seen, res)
    })
  })
}

// name=value pairs from Set-Cookie, sent back on every later request, the way a browser would for one origin
function jar() {
  const cookies = new Map<string, string>()
  return {
    async fetch(url: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers)
      if (cookies.size > 0) headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '))
      const res = await fetch(url, { ...init, headers, redirect: 'manual' })
      for (const line of res.headers.getSetCookie()) {
        const pair = line.split(';')[0]!
        const eq = pair.indexOf('=')
        cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1))
      }
      return res
    },
  }
}

beforeAll(async () => {
  api = stub(apiSeen, 'api', (seen, res) => {
    if (seen.url.startsWith('/v1/auth/login')) {
      res.statusCode = 201
      res.setHeader('set-cookie', ['session=abc123; Path=/; HttpOnly', 'second=two; Path=/'])
      res.end('logged in')
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ sawCookie: seen.headers.cookie ?? null }))
  })
  next = stub(nextSeen, 'next', (_seen, res) => {
    res.statusCode = 404
    res.end('next page')
  })
  const listen = (server: Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
    )
  const apiPort = await listen(api)
  const nextPort = await listen(next)
  const [proxyPort] = await freePorts(1)
  proxy = await startProxy({
    PROXY_PORT: String(proxyPort),
    API_PORT: String(apiPort),
    NEXT_PORT: String(nextPort),
  })
  base = `http://localhost:${proxyPort}`
})

afterAll(async () => {
  proxy?.removeAllListeners('exit')
  proxy?.kill()
  await Promise.all([api, next].map((s) => new Promise((resolve) => (s ? s.close(resolve) : resolve(undefined)))))
})

describe('dev proxy', () => {
  it('sends /v1/* to the API and everything else to next', async () => {
    const client = jar()
    apiSeen.length = nextSeen.length = 0
    const a = await client.fetch(`${base}/v1/rules`)
    const b = await client.fetch(`${base}/rules/`)
    const c = await client.fetch(`${base}/v1x`)
    expect(a.headers.get('x-upstream')).toBe('api')
    expect(b.headers.get('x-upstream')).toBe('next')
    expect(c.headers.get('x-upstream')).toBe('next')
    expect(apiSeen.map((s) => s.url)).toEqual(['/v1/rules'])
    expect(nextSeen.map((s) => s.url)).toEqual(['/rules/', '/v1x'])
  })

  it('returns the upstream status and every set-cookie header', async () => {
    const res = await fetch(`${base}/v1/auth/login`, { method: 'POST' })
    expect(res.status).toBe(201)
    expect(res.headers.getSetCookie()).toEqual(['session=abc123; Path=/; HttpOnly', 'second=two; Path=/'])
    expect(await res.text()).toBe('logged in')
    expect((await fetch(`${base}/anything`)).status).toBe(404)
  })

  it('carries the cookie a /v1 response set into the next /v1 request', async () => {
    const client = jar()
    const before = await (await client.fetch(`${base}/v1/rules`)).json()
    expect(before).toEqual({ sawCookie: null })
    await client.fetch(`${base}/v1/auth/login`, { method: 'POST' })
    const after = await (await client.fetch(`${base}/v1/rules`)).json()
    expect(after).toEqual({ sawCookie: 'session=abc123; second=two' })
  })

  it('forwards method, path, query, headers and body', async () => {
    apiSeen.length = 0
    await fetch(`${base}/v1/rules/r1?limit=5&cursor=a%20b`, {
      method: 'PUT',
      headers: { authorization: 'Bearer key-1', cookie: 'x=1', 'content-type': 'application/json', 'x-custom': 'yes' },
      body: JSON.stringify({ chainId: 8453 }),
    })
    const seen = apiSeen.at(-1)!
    expect(seen.method).toBe('PUT')
    expect(seen.url).toBe('/v1/rules/r1?limit=5&cursor=a%20b')
    expect(seen.body).toBe('{"chainId":8453}')
    expect(seen.headers).toMatchObject({
      authorization: 'Bearer key-1',
      cookie: 'x=1',
      'content-type': 'application/json',
      'x-custom': 'yes',
    })
  })

  it('answers 502 rather than hanging when the upstream is down', async () => {
    const [dead, port] = await freePorts(2)
    const child = await startProxy({ PROXY_PORT: String(port), API_PORT: String(dead), NEXT_PORT: String(dead) })
    try {
      const res = await fetch(`http://localhost:${port}/v1/rules`)
      expect(res.status).toBe(502)
    } finally {
      child.removeAllListeners('exit')
      child.kill()
    }
  })
})
