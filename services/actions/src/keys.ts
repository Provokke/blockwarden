import type { DeliveryRecord, DeliveryRef, DeliveryStatus } from './records.js'

// four digits order a transaction's history as numbers. seq counts every status change ever
// (historyBase keeps counting dropped entries), so it isn't bounded by MAX_HISTORY.
const SEQ_WIDTH = 4

// Four shards takes the due partition off a single write ceiling and keeps the sweep to four small
// queries. The number is part of the stored key, so changing it needs a migration.
export const DUE_SHARDS = 4

const MATCH_PREFIX = 'MATCH#'
const TX_PREFIX = 'TX#'

// A seq this high is a property of the record, so every retry throws again. Named so callers can
// tell it from a transient failure.
export class DeliverySeqRangeError extends RangeError {
  constructor(readonly seq: number) {
    super(`keys.delivery: seq must be an integer between 0 and 9999, got ${seq}`)
    this.name = 'DeliverySeqRangeError'
  }
}

export const keys = {
  matchSubject: (matchKey: string) => `${MATCH_PREFIX}${matchKey}`,
  txSubject: (txId: string) => `${TX_PREFIX}${txId}`,
  outboundSubject: (requestId: string) => `OUTBOUND#${requestId}`,
  isMatchSubject: (pk: string) => pk.startsWith(MATCH_PREFIX),
  isTxSubject: (pk: string) => pk.startsWith(TX_PREFIX),
  delivery: (subject: string, actionId: string, event: string, seq: number) => {
    // Past 9999 the padding stops sorting as a number, so fail loudly. Needs 10,000 status changes
    // on one tx, which only a reorg loop could cause. The width is baked into stored keys, so no
    // widening without a migration.
    if (!Number.isInteger(seq) || seq < 0 || seq > 9999) {
      throw new DeliverySeqRangeError(seq)
    }
    return {
      PK: subject,
      SK: `DELIVERY#${actionId}#${event}#${String(seq).padStart(SEQ_WIDTH, '0')}`,
    }
  },
  dueDeliveries: (shard: number) => `DELIVERY#DUE#${shard}`,
  // Every non-terminal write copies the delivery into the due index, and one partition caps at
  // about 1,000 writes a second. The shard comes from the delivery's own id so it never moves while
  // the reaper reads.
  dueShard: (deliveryId: string) => {
    // the id ends in a sha256 hex, so one digit spreads evenly over four shards
    const digit = Number.parseInt(deliveryId.slice(-1), 16)
    return Number.isNaN(digit) ? 0 : digit % DUE_SHARDS
  },
  deliveriesByStatus: (status: DeliveryStatus) => `DELIVERY#${status.toUpperCase()}`,
}

// The table key a delivery lives under, as a ref. Everything that names a delivery to a queue
// builds it here so they don't drift apart.
export function refOf(delivery: Pick<DeliveryRecord, 'subject' | 'actionId' | 'event' | 'seq'>): DeliveryRef {
  return {
    subject: delivery.subject,
    sk: keys.delivery(delivery.subject, delivery.actionId, delivery.event, delivery.seq).SK,
  }
}
