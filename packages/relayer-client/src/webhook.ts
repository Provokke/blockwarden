import {
  MATCH_STATUSES,
  TX_STATUSES,
  type DecodedValue,
  type MatchEventData,
  type MatchStatus,
  type RelayerTx,
  type RelayerTxBody,
  type TxStatus,
} from './types.js'
import { isMatchBody, isTxBody } from './validate.js'

export const SIGNATURE_HEADER = 'x-blockwarden-signature'
export const DELIVERY_HEADER = 'x-blockwarden-delivery'
export const DEFAULT_TOLERANCE_SECONDS = 300

// The schema published at docs/webhooks/v1.md. A body's shape changes only with this number, which is why a
// reader should branch on it rather than on the presence of a field.
export const WEBHOOK_SPEC_VERSION = 1

// The timestamp is not a header of its own: it is the t= part of X-Blockwarden-Signature, in unix seconds.
export const TIMESTAMP_TOLERANCE_SECONDS = DEFAULT_TOLERANCE_SECONDS

export type WebhookEvent = {
  // the delivery id, also sent as X-Blockwarden-Delivery, for receiver-side idempotency
  id: string
  type: string
  createdAt: string
  // the schema version of data; 1 today, absent on a body from a sender older than this field
  specVersion?: number
  data: unknown
}

export type TxEvent = WebhookEvent & { type: `tx.${TxStatus}`; data: RelayerTxBody }

export type MatchEvent = WebhookEvent & { type: `match.${MatchStatus}`; data: MatchEventData }

export function isMatchEvent(event: WebhookEvent): event is MatchEvent {
  return (MATCH_STATUSES as readonly string[]).some((s) => event.type === `match.${s}`) && isMatchBody(event.data)
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebhookVerificationError'
  }
}

export type VerifyWebhookOptions = {
  // the raw request body, exactly as received; a re-serialised body will not verify
  payload: string
  // the X-Blockwarden-Signature header
  signature: string | null | undefined
  // several secrets are allowed while one is being rotated
  secret: string | string[]
  toleranceSeconds?: number
  nowMs?: number
}

// The header is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<payload>">`. A header can carry several v1 values.
export async function verifyWebhook(options: VerifyWebhookOptions): Promise<WebhookEvent> {
  const { timestamp, signatures } = parseHeader(options.signature)
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new WebhookVerificationError('toleranceSeconds must be a finite number that is not negative')
  }
  if (options.nowMs !== undefined && !Number.isFinite(options.nowMs)) {
    throw new WebhookVerificationError('nowMs must be a finite number')
  }
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000)
  if (Math.abs(now - timestamp) > tolerance) {
    throw new WebhookVerificationError(`the signature timestamp is more than ${tolerance} seconds from now`)
  }
  const secrets: unknown[] = Array.isArray(options.secret) ? options.secret : [options.secret]
  if (secrets.some((s) => typeof s !== 'string')) throw new WebhookVerificationError('webhook secret must be a string')
  if (secrets.length === 0 || secrets.some((s) => (s as string).length === 0)) {
    throw new WebhookVerificationError('webhook secret must not be empty')
  }
  let matched = false
  for (const secret of secrets) {
    const expected = await hmacHex(secret as string, `${timestamp}.${options.payload}`)
    // every candidate is compared, so the time taken does not reveal which one matched
    for (const candidate of signatures) if (constantTimeEqual(candidate, expected)) matched = true
  }
  if (!matched) throw new WebhookVerificationError('no signature matches the payload')

  let event: unknown
  try {
    event = JSON.parse(options.payload)
  } catch {
    throw new WebhookVerificationError('the payload is not JSON')
  }
  const e = event as Partial<WebhookEvent> | null
  if (!e || typeof e.id !== 'string' || typeof e.type !== 'string' || typeof e.createdAt !== 'string') {
    throw new WebhookVerificationError('the payload is not a Blockwarden event')
  }
  return e as WebhookEvent
}

export async function signWebhook(options: { payload: string; secret: string; nowMs?: number }): Promise<string> {
  if (typeof options.secret !== 'string' || options.secret.length === 0) {
    throw new TypeError('webhook secret must not be empty')
  }
  const timestamp = Math.floor((options.nowMs ?? Date.now()) / 1000)
  return `t=${timestamp},v1=${await hmacHex(options.secret, `${timestamp}.${options.payload}`)}`
}

export function isTxEvent(event: WebhookEvent): event is TxEvent {
  return (TX_STATUSES as readonly string[]).some((status) => event.type === `tx.${status}`) && isTxBody(event.data)
}

export function parseTx(body: RelayerTxBody): RelayerTx {
  // a 0.1.x sender leaves revertData out altogether, and the type promises one either way
  return { ...body, value: BigInt(body.value), gasLimit: BigInt(body.gasLimit), revertData: body.revertData ?? null }
}

// The sending half of the wire form, where parseTx is the receiving half. viem decodes an ABI integer of 48
// bits or fewer as a JS number and anything wider as a bigint, but the schema publishes every integer as a
// decimal string, so a sender converts here and the guard stays strict for everyone reading a payload.
export function toDecodedValue(value: unknown): DecodedValue {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    // no ABI integer decodes to a fraction, so this is a bug in whatever built the value, not a value to round
    if (!Number.isSafeInteger(value)) throw new TypeError(`${value} is not an integer, so it is not a decoded value`)
    return value.toString()
  }
  if (Array.isArray(value)) return value.map(toDecodedValue)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, toDecodedValue(v)]))
  }
  // a string, a hex string and a boolean are already the wire form
  return value as DecodedValue
}

function parseHeader(header: string | null | undefined): { timestamp: number; signatures: string[] } {
  if (!header) throw new WebhookVerificationError('the signature header is missing')
  let timestamp: number | undefined
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2)
    if (key === 't' && value && /^\d+$/.test(value)) timestamp = Number(value)
    if (key === 'v1' && value && /^[0-9a-f]{64}$/.test(value)) signatures.push(value)
  }
  if (timestamp === undefined) throw new WebhookVerificationError('the signature header has no timestamp')
  if (signatures.length === 0) throw new WebhookVerificationError('the signature header has no v1 signature')
  return { timestamp, signatures }
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
