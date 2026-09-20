import type { DeliveryStatus } from './records.js'

// four digits order the history entries of a transaction as numbers; the relayer caps its history well below 9999
const SEQ_WIDTH = 4

// Four is enough to take the due partition off a single write ceiling, and few enough that the reaper's sweep
// is still four small queries. The number is part of the stored key: raising it later strands deliveries in
// shards nothing reads, so it changes only with a migration.
export const DUE_SHARDS = 4

export const keys = {
  matchSubject: (matchKey: string) => `MATCH#${matchKey}`,
  txSubject: (txId: string) => `TX#${txId}`,
  outboundSubject: (requestId: string) => `OUTBOUND#${requestId}`,
  delivery: (subject: string, actionId: string, event: string, seq: number) => {
    // past 9999 the padding stops sorting as a number; fail loudly here rather than misorder history silently
    if (!Number.isInteger(seq) || seq < 0 || seq > 9999) {
      throw new RangeError(`keys.delivery: seq must be an integer between 0 and 9999, got ${seq}`)
    }
    return {
      PK: subject,
      SK: `DELIVERY#${actionId}#${event}#${String(seq).padStart(SEQ_WIDTH, '0')}`,
    }
  },
  dueDeliveries: (shard: number) => `DELIVERY#DUE#${shard}`,
  // Every non-terminal write copies the whole delivery into the due index, so one partition would take the lot
  // and a partition is capped at about 1,000 writes a second. Sharding spreads that; the shard comes from the
  // delivery's own id so a delivery never moves between shards while the reaper is reading them.
  dueShard: (deliveryId: string) => {
    // the id ends in the hex of a sha256, so one digit already spreads evenly over four shards
    const digit = Number.parseInt(deliveryId.slice(-1), 16)
    return Number.isNaN(digit) ? 0 : digit % DUE_SHARDS
  },
  deliveriesByStatus: (status: DeliveryStatus) => `DELIVERY#${status.toUpperCase()}`,
}
