import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { checkDestinationUrl, classifyAddress } from '@blockwarden/core'

export class DestinationError extends Error {
  // a refused range or a bad URL will be refused again next time; a resolver that could not answer may not be
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'DestinationError'
  }
}

export type Resolved = { url: URL; host: string; address: string; family: 4 | 6; port: number }
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>

export const MAX_RESPONSE_BYTES = 2048
export const DEFAULT_TIMEOUT_MS = 10_000

const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true })

export async function resolveDestination(raw: string, resolve: Resolver = systemResolver): Promise<Resolved> {
  const checked = checkDestinationUrl(raw)
  if (!checked.ok) throw new DestinationError(`the destination is refused: ${checked.reason}`)
  const { url } = checked
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  const port = Number(url.port || 443)

  // a literal address was already judged by checkDestinationUrl; asking a resolver about it would be a second
  // chance to say yes
  if (isIP(host) !== 0) {
    return { url, host, address: host, family: isIP(host) === 6 ? 6 : 4, port }
  }

  let addresses: { address: string; family: number }[]
  try {
    addresses = await resolve(host)
  } catch (err) {
    throw new DestinationError(
      `the destination could not be resolved: ${(err as { code?: string }).code ?? 'lookup failed'}`,
      true,
    )
  }
  if (addresses.length === 0) throw new DestinationError('the destination does not resolve to any address', true)
  for (const { address } of addresses) {
    const verdict = classifyAddress(address)
    if (!verdict.allowed) throw new DestinationError(`the destination is refused: ${verdict.reason}`)
  }
  const [first] = addresses
  return { url, host, address: first!.address, family: first!.family === 6 ? 6 : 4, port }
}

export type HttpAnswer = { statusCode: number; retryAfterSeconds?: number; body: string; remoteAddress?: string }

export function postJson(
  target: Resolved,
  body: string,
  headers: Record<string, string>,
  options: { timeoutMs?: number } = {},
): Promise<HttpAnswer> {
  const secure = target.url.protocol === 'https:'
  const transport = secure ? https : http
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        host: target.host,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'POST',
        // no pooled socket, so every attempt resolves through the pinned lookup below
        agent: false,
        // the certificate is checked against the name, not the pinned address
        ...(secure ? { servername: target.host } : {}),
        // Node calls this instead of DNS, so the connection goes to the address the guard judged. A second
        // resolution — the rebinding window — never happens. Node 24 calls it with { all: true }.
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
          opts && opts.all
            ? cb(null, [{ address: target.address, family: target.family }])
            : cb(null, target.address, target.family)) as unknown as typeof import('node:dns').lookup,
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'Blockwarden/1',
        },
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (response) => {
        // a redirect is never followed: its status is the answer
        let read = 0
        let text = ''
        response.on('data', (chunk: Buffer) => {
          read += chunk.length
          if (text.length < MAX_RESPONSE_BYTES) text += chunk.toString('utf8')
          // the first chunk can already be 64 KB, so this caps what is kept, not what arrives
          if (read > MAX_RESPONSE_BYTES) response.destroy()
        })
        response.on('close', () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            ...retryAfter(response.headers['retry-after']),
            body: text.slice(0, MAX_RESPONSE_BYTES),
            ...(response.socket.remoteAddress ? { remoteAddress: response.socket.remoteAddress } : {}),
          }),
        )
      },
    )
    request.on('timeout', () => request.destroy(new Error('the destination did not answer in time')))
    request.on('error', reject)
    request.end(body)
  })
}

function retryAfter(header: string | string[] | undefined): { retryAfterSeconds?: number } {
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return {}
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return { retryAfterSeconds: seconds }
  const date = Date.parse(value)
  return Number.isNaN(date) ? {} : { retryAfterSeconds: Math.max(0, Math.round((date - Date.now()) / 1000)) }
}
