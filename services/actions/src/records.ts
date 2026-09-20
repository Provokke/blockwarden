import type { Hex } from 'viem'

export type DeliveryChannel = 'webhook' | 'email' | 'telegram' | 'relay' | 'sqs' | 'lambda'

// every component takes the same logger shape, so nothing has to reach into Powertools; info unless a level is
// given, and a failure goes to warn or error so a filter on the level finds it
export type Log = (message: string, data?: Record<string, unknown>, level?: 'warn' | 'error') => void

// pending: the item exists but no message has been sent yet; queued: a message is on the queue;
// delivering: a sender has claimed it; failed is not terminal, it is waiting for its next attempt
export type DeliveryStatus = 'pending' | 'queued' | 'delivering' | 'delivered' | 'failed' | 'dead'

export const TERMINAL: ReadonlySet<DeliveryStatus> = new Set(['delivered', 'dead'])

export type DeliveryTarget =
  | {
      channel: 'webhook'
      url: string
      secretParameter?: string
      // Project B's merchants see their own header name, not ours
      signatureHeader?: string
      deliveryHeader?: string
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
  // the exact bytes signed and sent; a redrive sends these again rather than rendering the item afresh
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

export const DELIVERY_TTL_SECONDS = 30 * 24 * 60 * 60

// A delivery holds the bytes it sends. The table's item limit is 400 KB, and a payload anywhere near this is a
// rule matching something it should not; the dispatcher fails the delivery rather than storing it.
export const MAX_PAYLOAD_BYTES = 64 * 1024

// the same rule as a node's refusal in the relayer: a receiver can answer with a whole HTML page
export const MAX_ERROR_CHARACTERS = 256

export function truncate(text: string, max = MAX_ERROR_CHARACTERS): string {
  if (text.length <= max) return text
  let end = max
  // slice() counts UTF-16 code units; back off one so we don't split a surrogate pair and leave a lone
  // surrogate, which DynamoDB stores as a replacement character
  if (end > 0 && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1
  return `${text.slice(0, end)}...`
}
