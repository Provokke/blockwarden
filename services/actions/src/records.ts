import type { Hex } from 'viem'

export type DeliveryChannel = 'webhook' | 'email' | 'telegram' | 'relay' | 'sqs' | 'lambda'

// every component takes the same logger shape so nothing reaches into Powertools; failures go to
// warn or error so level filters find them
export type Log = (message: string, data?: Record<string, unknown>, level?: 'warn' | 'error') => void

// pending: item exists, no message yet. queued: message on the queue. delivering: a sender claimed
// it. failed isn't terminal, it's waiting for its next attempt.
export type DeliveryStatus = 'pending' | 'queued' | 'delivering' | 'delivered' | 'failed' | 'dead'

export const TERMINAL: ReadonlySet<DeliveryStatus> = new Set(['delivered', 'dead'])

export type DeliveryTarget =
  | {
      channel: 'webhook'
      url: string
      secretParameter?: string
      // merchants see their own header name, not ours
      signatureHeader?: string
      deliveryHeader?: string
      // what the delivery header carries; an outbound request sets its own, everything else uses the delivery id
      eventId?: string
    }
  | { channel: 'email'; to: string[]; subject?: string }
  | { channel: 'telegram'; chatId: string }
  | {
      channel: 'relay'
      signerId: string
      chainId: number
      to: Hex
      data: Hex
      value?: string
      gasLimit?: string
    }
  | { channel: 'sqs'; queueArn: string }
  | { channel: 'lambda'; functionArn: string }

export type DeliveryRecord = {
  deliveryId: string
  // the item this delivery belongs to: MATCH#<matchKey>, TX#<txId> or OUTBOUND#<requestId>
  subject: string
  actionId: string
  event: string
  seq: number
  channel: DeliveryChannel
  target: DeliveryTarget
  // the exact bytes signed and sent; a redrive resends these instead of rendering afresh
  payload: string
  status: DeliveryStatus
  attempts: number
  nextAttemptAt?: number
  firstAttemptAt?: number
  lastAttemptAt?: number
  lastError?: string
  lastStatusCode?: number
  createdAt: string
  updatedAt: string
  version: number
  expiresAt: number
}

export type NewDelivery = Pick<
  DeliveryRecord,
  'deliveryId' | 'subject' | 'actionId' | 'event' | 'seq' | 'channel' | 'target' | 'payload'
>

// what an SQS message carries: enough to read the item, nothing that could go stale
export type DeliveryRef = { subject: string; sk: string }

export const DELIVERY_TTL_SECONDS = 30 * 24 * 60 * 60

// A delivery holds the bytes it sends. The table's item limit is 400 KB, and a payload near this
// means a rule is matching something it shouldn't, so the dispatcher fails it.
export const MAX_PAYLOAD_BYTES = 64 * 1024

// A property of the payload: the same bytes are refused every time, so callers can tell this from a
// throttle and stop retrying.
export class PayloadTooLargeError extends Error {
  constructor(
    readonly deliveryId: string,
    readonly bytes: number,
  ) {
    super(`delivery ${deliveryId} payload is larger than ${MAX_PAYLOAD_BYTES} bytes`)
    this.name = 'PayloadTooLargeError'
  }
}

// same rule as a node's refusal in the relayer: a receiver can answer with a whole HTML page
export const MAX_ERROR_CHARACTERS = 256

export function truncate(text: string, max = MAX_ERROR_CHARACTERS): string {
  if (text.length <= max) return text
  let end = max
  // slice() counts UTF-16 units; back off one so we don't leave a lone surrogate (DynamoDB stores
  // it as a replacement char)
  if (end > 0 && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1
  return `${text.slice(0, end)}...`
}
