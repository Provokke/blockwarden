import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { checkDestinationUrl, classifyAddress } from '@blockwarden/core'

export class DestinationError extends Error {
  // A refused range or bad URL will be refused again; a resolver that couldn't answer may work next
  // time.
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
// how long the socket may stay silent
export const DEFAULT_TIMEOUT_MS = 10_000
// Cap on the whole attempt. The socket timeout only measures silence, so a slow trickle could hold
// the sender for hours. Half the Lambda's 30s, leaving room to record the outcome and queue the
// next try. Above DEFAULT_TIMEOUT_MS so the silence rule bites first.
export const DEFAULT_DEADLINE_MS = 15_000

const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true })

export async function resolveDestination(raw: string, resolve: Resolver = systemResolver): Promise<Resolved> {
  const checked = checkDestinationUrl(raw)
  if (!checked.ok) throw new DestinationError(`the destination is refused: ${checked.reason}`)
  const { url } = checked
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  const port = Number(url.port || 443)

  // A literal address was already judged by checkDestinationUrl, so skip the resolver.
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
  options: { timeoutMs?: number; deadlineMs?: number } = {},
): Promise<HttpAnswer> {
  const secure = target.url.protocol === 'https:'
  const transport = secure ? https : http
  // Node calls this instead of DNS, so the connection goes to the address the guard judged (no
  // rebinding window). Node 24 passes { all: true }.
  const pinned: LookupFunction = (_host, lookupOptions, cb) =>
    lookupOptions && lookupOptions.all
      ? cb(null, [{ address: target.address, family: target.family }])
      : cb(null, target.address, target.family)
  return new Promise((resolve, reject) => {
    let deadline: NodeJS.Timeout | undefined
    // set when a timer ends the attempt, so the half-read response doesn't explain it instead
    let givenUp = false
    const giveUp = (err: Error) => {
      givenUp = true
      request.destroy(err)
    }
    const done = (answer: HttpAnswer) => {
      clearTimeout(deadline)
      resolve(answer)
    }
    const failed = (err: Error) => {
      clearTimeout(deadline)
      reject(err)
    }
    const request = transport.request(
      {
        host: target.host,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'POST',
        // no pooled socket, so every attempt goes through the pinned lookup
        agent: false,
        // cert is checked against the name, not the pinned address
        ...(secure ? { servername: target.host } : {}),
        lookup: pinned,
        // computed headers go last so a caller-supplied header can't displace them
        headers: {
          ...headers,
          host: hostHeader(target, secure),
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'Blockwarden/1',
        },
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (response) => {
        // never follow a redirect, its status is the answer
        // Read the address now, a TLS socket the destination closes is gone by the time the body
        // ends.
        const peer = response.socket.remoteAddress
        let read = 0
        let capped = false
        let kept = 0
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          read += chunk.length
          // bytes, not characters, or two-byte chars buy twice the cap
          if (kept < MAX_RESPONSE_BYTES) {
            const slice = chunk.subarray(0, MAX_RESPONSE_BYTES - kept)
            chunks.push(slice)
            kept += slice.length
          }
          // the first chunk can already be 64 KB, so this caps what's kept, not what arrives
          if (read > MAX_RESPONSE_BYTES) {
            capped = true
            response.destroy()
          }
        })
        response.on('close', () => {
          // the request error carries why a timer ended this
          if (givenUp) return
          // A body that stops early isn't an answer. Stopping at our own cap isn't the
          // destination's fault, so that still counts.
          if (!capped && !response.complete) {
            return failed(new Error('the destination closed the connection before the answer was complete'))
          }
          done({
            statusCode: response.statusCode ?? 0,
            ...retryAfter(response.headers['retry-after']),
            // the decoder holds back a split character and drops one the cap cut in half
            body: new StringDecoder('utf8').write(Buffer.concat(chunks)),
            ...(peer ? { remoteAddress: peer } : {}),
          })
        })
      },
    )
    request.on('timeout', () => giveUp(new Error('the destination did not answer in time')))
    request.on('error', failed)
    request.end(body)
    // armed once the request is on its way, cleared however it settles; the socket timeout can't
    // catch a trickle
    deadline = setTimeout(
      () => giveUp(new Error('the destination took longer than the deadline')),
      options.deadlineMs ?? DEFAULT_DEADLINE_MS,
    )
  })
}

// what Node would write itself: the name (bracketed if IPv6) and the port unless it's the default
function hostHeader(target: Resolved, secure: boolean): string {
  const name = isIP(target.host) === 6 ? `[${target.host}]` : target.host
  return target.port === (secure ? 443 : 80) ? name : `${name}:${target.port}`
}

function retryAfter(header: string | string[] | undefined): { retryAfterSeconds?: number } {
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return {}
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return { retryAfterSeconds: seconds }
  const date = Date.parse(value)
  return Number.isNaN(date) ? {} : { retryAfterSeconds: Math.max(0, Math.round((date - Date.now()) / 1000)) }
}
