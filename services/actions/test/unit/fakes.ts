import type { DeliveryQueue } from '../../src/queue.js'
import type { CompiledRuleView, Lookup, SignerView } from '../../src/lookup.js'
import type { DeliveryRecord, DeliveryRef, NewDelivery } from '../../src/records.js'
import { keys } from '../../src/keys.js'
import { REAPER_GRACE_MS } from '../../src/store.js'

export function fakeQueue() {
  const sent: { ref: DeliveryRef; delaySeconds: number }[] = []
  const queue: DeliveryQueue = {
    send: async (ref, delaySeconds) => {
      sent.push({ ref, delaySeconds })
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

// an in-memory stand-in for DeliveryStore with the same methods the dispatcher uses
export function fakeStore() {
  const items = new Map<string, DeliveryRecord>()
  const id = (ref: DeliveryRef) => `${ref.subject}|${ref.sk}`
  const store = {
    async create(delivery: NewDelivery, now: Date): Promise<DeliveryRecord | undefined> {
      const { SK } = keys.delivery(delivery.subject, delivery.actionId, delivery.event, delivery.seq)
      const key = id({ subject: delivery.subject, sk: SK })
      if (items.has(key)) return undefined
      const record: DeliveryRecord = {
        ...delivery,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now.getTime(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        version: 0,
        expiresAt: 0,
      }
      items.set(key, record)
      return record
    },
    // mirrors store.ts: queuing moves the due time out by the reaper's grace, or every sweep would queue this
    // delivery again the moment it looked at it
    async markQueued(delivery: DeliveryRecord, nowMs: number) {
      const next = {
        ...delivery,
        status: 'queued' as const,
        nextAttemptAt: nowMs + REAPER_GRACE_MS,
        version: delivery.version + 1,
      }
      items.set(
        id({
          subject: delivery.subject,
          sk: keys.delivery(delivery.subject, delivery.actionId, delivery.event, delivery.seq).SK,
        }),
        next,
      )
      return next
    },
    async markDead(delivery: DeliveryRecord, nowMs: number, error: string) {
      const { nextAttemptAt: _dropped, ...rest } = delivery
      const next = {
        ...rest,
        status: 'dead' as const,
        lastError: error,
        updatedAt: new Date(nowMs).toISOString(),
        version: delivery.version + 1,
      }
      items.set(
        id({
          subject: delivery.subject,
          sk: keys.delivery(delivery.subject, delivery.actionId, delivery.event, delivery.seq).SK,
        }),
        next,
      )
      return next
    },
    async listDue() {
      return [...items.values()].filter((d) => d.status !== 'delivered' && d.status !== 'dead')
    },
    // the real store pages over four shards; the fake pages over one list, which is all the sweep can tell apart.
    // It still has to honour nowMs the way the real GSI2SK query does (delivery.nextAttemptAt, defaulting to 0
    // the same way item() does), or every non-terminal delivery reads as due regardless of when it's due.
    async listDuePage(nowMs: number, limit: number, cursor?: { from?: number }) {
      const all = [...items.values()]
        .filter((d) => d.status !== 'delivered' && d.status !== 'dead')
        .filter((d) => (d.nextAttemptAt ?? 0) <= nowMs)
      const from = cursor?.from ?? 0
      const deliveries = all.slice(from, from + limit)
      const next = from + deliveries.length
      return { deliveries, ...(next < all.length ? { cursor: { from: next } } : {}) }
    },
  }
  return { store, items }
}
