import type { RelayerTx, RelayerTxBody, TxStatus } from './types.js'

export const SIGNATURE_HEADER = 'x-blockwarden-signature'
export const DELIVERY_HEADER = 'x-blockwarden-delivery'
export const DEFAULT_TOLERANCE_SECONDS = 300

export type WebhookEvent = {
  // the delivery id, also sent as X-Blockwarden-Delivery, for receiver-side idempotency
  id: string
  type: string
  createdAt: string
  data: unknown
}

export type TxEvent = WebhookEvent & { type: `tx.${TxStatus}`; data: RelayerTxBody }

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
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000)
  if (Math.abs(now - timestamp) > tolerance) {
    throw new WebhookVerificationError(`the signature timestamp is more than ${tolerance} seconds from now`)
  }
  const secrets = Array.isArray(options.secret) ? options.secret : [options.secret]
  let matched = false
  for (const secret of secrets) {
    const expected = await hmacHex(secret, `${timestamp}.${options.payload}`)
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
  const timestamp = Math.floor((options.nowMs ?? Date.now()) / 1000)
  return `t=${timestamp},v1=${await hmacHex(options.secret, `${timestamp}.${options.payload}`)}`
}

export function isTxEvent(event: WebhookEvent): event is TxEvent {
  return event.type.startsWith('tx.')
}

export function parseTx(body: RelayerTxBody): RelayerTx {
  return { ...body, value: BigInt(body.value), gasLimit: BigInt(body.gasLimit) }
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
