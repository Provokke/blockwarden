import { MAX_DELAY_SECONDS, type DeliveryQueue } from '../../src/queue.js'
import type { CompiledRuleView, Lookup, SignerView } from '../../src/lookup.js'
import {
  DELIVERY_TTL_SECONDS,
  MAX_PAYLOAD_BYTES,
  PayloadTooLargeError,
  TERMINAL,
  truncate,
  type DeliveryRecord,
  type DeliveryRef,
} from '../../src/records.js'
import { keys } from '../../src/keys.js'
import { DeliveryConflictError, REAPER_GRACE_MS, type DeliveryStore, type DueCursor } from '../../src/store.js'

export function fakeQueue() {
  const sent: { ref: DeliveryRef; delaySeconds: number }[] = []
  const queue: DeliveryQueue = {
    // sqsDeliveryQueue clamps and rounds before SQS sees the delay, so recording the raw number would let a
    // caller pass one SQS refuses and no test would notice
    send: async (ref, delaySeconds) => {
      sent.push({ ref, delaySeconds: Math.max(0, Math.min(MAX_DELAY_SECONDS, Math.round(delaySeconds))) })
    },
  }
  return { queue, sent }
}

export function fakeLookup(rules: Record<string, CompiledRuleView>, signers: Record<string, SignerView> = {}): Lookup {
  return {
    rule: async (ruleId) => rules[ruleId],
    signer: async (signerId) => signers[signerId],
  }
}

// the store methods the fake stands in for; taking them off DeliveryStore is what makes the fake diverging from
// the real store a compile error rather than something a test quietly proves nothing about
export type FakeDeliveryStore = Pick<DeliveryStore, 'create' | 'markQueued' | 'markDead' | 'listDue' | 'listDuePage'>

// where a page of the fake's due index stopped: the real store keeps the last item's keys per shard, and the
// fake keeps the same thing for its one list, so requeuing an item does not shift the position of the next page
type FakeStartKey = { due: number; key: string }

// an in-memory stand-in for DeliveryStore with the same methods the dispatcher uses
export function fakeStore(): { store: FakeDeliveryStore; items: Map<string, DeliveryRecord> } {
  const items = new Map<string, DeliveryRecord>()
  const keyOf = (d: Pick<DeliveryRecord, 'subject' | 'actionId' | 'event' | 'seq'>) =>
    `${d.subject}|${keys.delivery(d.subject, d.actionId, d.event, d.seq).SK}`

  // mirrors store.save: the write is conditioned on the version that was read, and the loser of a race gets a
  // conflict rather than overwriting the winner
  function save(next: DeliveryRecord, previous: DeliveryRecord, nowMs: number): DeliveryRecord {
    const key = keyOf(previous)
    const stored = items.get(key)
    if (stored && stored.version !== previous.version) throw new DeliveryConflictError(previous.deliveryId)
    const saved = { ...next, version: previous.version + 1, updatedAt: new Date(nowMs).toISOString() }
    items.set(key, saved)
    return saved
  }

  const due = (d: DeliveryRecord) => d.nextAttemptAt ?? 0

  const store: FakeDeliveryStore = {
    async create(delivery, now) {
      // the real store refuses an oversized payload before it writes anything, and the dispatcher's handling of
      // that refusal is only worth testing against a fake that makes it
      if (Buffer.byteLength(delivery.payload, 'utf8') > MAX_PAYLOAD_BYTES) {
        throw new PayloadTooLargeError(delivery.deliveryId, Buffer.byteLength(delivery.payload, 'utf8'))
      }
      const key = keyOf(delivery)
      if (items.has(key)) return undefined
      const nowMs = now.getTime()
      const record: DeliveryRecord = {
        ...delivery,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: nowMs,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        version: 0,
        expiresAt: Math.floor(nowMs / 1000) + DELIVERY_TTL_SECONDS,
      }
      items.set(key, record)
      return record
    },
    // mirrors store.ts: queuing moves the due time out by the reaper's grace, or every sweep would queue this
    // delivery again the moment it looked at it
    async markQueued(delivery, nowMs) {
      return save({ ...delivery, status: 'queued', nextAttemptAt: nowMs + REAPER_GRACE_MS }, delivery, nowMs)
    },
    async markDead(delivery, nowMs, error) {
      const { nextAttemptAt: _dropped, ...rest } = delivery
      return save({ ...rest, status: 'dead', lastError: truncate(error) }, delivery, nowMs)
    },
    async listDue(nowMs, limit) {
      return (await store.listDuePage(nowMs, limit)).deliveries
    },
    // the real store pages four shards and merges them oldest first; the fake pages one list, which is all the
    // sweep can tell apart, but it has to sort and to honour nowMs the same way (delivery.nextAttemptAt,
    // defaulting to 0 as item() does, queried with GSI2SK <= :now) or every delivery reads as due, in any order
    async listDuePage(nowMs, limit, cursor) {
      const all = [...items.values()]
        .filter((d) => !TERMINAL.has(d.status))
        .filter((d) => due(d) <= nowMs)
        .sort((a, b) => due(a) - due(b) || keyOf(a).localeCompare(keyOf(b)))
      const from = cursor?.['0'] as FakeStartKey | undefined
      const rest = from ? all.filter((d) => due(d) > from.due || (due(d) === from.due && keyOf(d) > from.key)) : all
      const deliveries = rest.slice(0, limit)
      const last = deliveries[deliveries.length - 1]
      const next: DueCursor = last ? { 0: { due: due(last), key: keyOf(last) } } : {}
      return { deliveries, ...(rest.length > deliveries.length ? { cursor: next } : {}) }
    },
  }
  return { store, items }
}
