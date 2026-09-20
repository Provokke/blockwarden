import { MetricUnit } from '@aws-lambda-powertools/metrics'
import { describe, expect, it, vi } from 'vitest'
import { DeliveryConflictError } from '../../src/store.js'
import { CLAIM_LEASE_MS } from '../../src/dispatcher.js'
import { keys } from '../../src/keys.js'
import { DEADLINE_MARGIN_MS, processDelivery, processMessages, type SenderStore } from '../../src/sender.js'
import type { DeliveryRecord, DeliveryRef } from '../../src/records.js'
import type { SendOutcome } from '../../src/senders/types.js'
import { fakeQueue, fakeStore } from './fakes.js'

const ref: DeliveryRef = { subject: 'MATCH#0x1', sk: keys.delivery('MATCH#0x1', 'a_1', 'match.final', 0).SK }
const itemKey = `${ref.subject}|${ref.sk}`

const record = (overrides: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  deliveryId: 'dlv_1',
  subject: 'MATCH#0x1',
  actionId: 'a_1',
  event: 'match.final',
  seq: 0,
  channel: 'webhook',
  target: { channel: 'webhook', url: 'https://example.com/hook' },
  payload: '{}',
  status: 'queued',
  attempts: 0,
  createdAt: 'now',
  updatedAt: 'now',
  version: 1,
  expiresAt: 0,
  ...overrides,
})

// what the store hands back from claim(), which is the record every later write has to be conditioned on
const claimed = (stored: DeliveryRecord = record()): DeliveryRecord => ({
  ...stored,
  status: 'delivering',
  attempts: stored.attempts + 1,
  firstAttemptAt: 1_000,
  lastAttemptAt: 1_000,
  nextAttemptAt: 1_000 + CLAIM_LEASE_MS,
  version: stored.version + 1,
  updatedAt: new Date(1_000).toISOString(),
})

// a default parameter substitutes whenever the argument is undefined, not only when it is omitted, so it
// cannot tell "use the default record" apart from "the delivery is gone" (also undefined); a rest parameter,
// read by its length, can
const deps = (outcome: SendOutcome | Error, ...storedArgs: [DeliveryRecord | undefined] | []) => {
  const stored = storedArgs.length > 0 ? storedArgs[0] : record()
  // the same version-conditioned in-memory store the dispatcher's tests use, spied on: a hand-rolled mock that
  // never bumped a version would pass calls the real store refuses
  const { store: fake, items } = fakeStore()
  if (stored) items.set(itemKey, stored)
  const store = {
    get: vi.fn(fake.get),
    claim: vi.fn(fake.claim),
    markDelivered: vi.fn(fake.markDelivered),
    scheduleRetry: vi.fn(fake.scheduleRetry),
    markDead: vi.fn(fake.markDead),
  } satisfies SenderStore
  const queue = { send: vi.fn(fakeQueue().queue.send) }
  const deadLetters = { send: vi.fn(fakeQueue().queue.send) }
  const send = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome
    return outcome
  })
  // stands in for the Powertools Metrics instance: only the one method the pipeline calls
  const addMetric = vi.fn()
  const metrics = { singleMetric: () => ({ addMetric, addDimension: vi.fn() }) }
  return {
    deps: {
      store,
      queue,
      deadLetters,
      senders: { webhook: send, email: send, telegram: send, relay: send, sqs: send, lambda: send },
      secrets: { read: async () => ['s'] },
      now: () => 1_000,
      log: vi.fn(),
      random: () => 0.5,
      metrics: metrics as never,
    },
    store,
    queue,
    deadLetters,
    send,
    items,
    addMetric,
  }
}

describe('processDelivery', () => {
  it('claims, sends and marks delivered', async () => {
    const d = deps({ kind: 'delivered', statusCode: 204 })
    expect(await processDelivery(d.deps, ref)).toBe('delivered')
    expect(d.store.get).toHaveBeenCalledWith(ref)
    expect(d.store.claim).toHaveBeenCalledWith(record(), 1_000, CLAIM_LEASE_MS)
    expect(d.send).toHaveBeenCalledOnce()
    expect(d.store.markDelivered).toHaveBeenCalledWith(claimed(), 1_000, 204)
    expect(d.queue.send).not.toHaveBeenCalled()
    expect(d.deadLetters.send).not.toHaveBeenCalled()
    expect(d.addMetric).not.toHaveBeenCalled()
  })

  it('schedules the next attempt and enqueues it with a delay', async () => {
    const d = deps({ kind: 'retry', error: 'the destination answered 503', statusCode: 503 })
    expect(await processDelivery(d.deps, ref)).toBe('retrying')
    expect(d.store.scheduleRetry).toHaveBeenCalledWith(
      claimed(),
      1_000,
      1_000 + 10_000,
      'the destination answered 503',
      503,
    )
    expect(d.queue.send).toHaveBeenCalledWith(ref, 10)
    // an ordinary retry is not a death; counting it would make the dead-deliveries metric meaningless
    expect(d.addMetric).not.toHaveBeenCalled()
  })

  it('lets a destination ask for a longer wait than the backoff', async () => {
    const d = deps({ kind: 'retry', error: 'the destination answered 429', statusCode: 429, afterSeconds: 120 })
    expect(await processDelivery(d.deps, ref)).toBe('retrying')
    expect(d.store.scheduleRetry).toHaveBeenCalledWith(claimed(), 1_000, 1_000 + 120_000, expect.any(String), 429)
    expect(d.queue.send).toHaveBeenCalledWith(ref, 120)
  })

  it("caps a destination's ask at what the queue can hold", async () => {
    const d = deps({ kind: 'retry', error: 'come back tomorrow', statusCode: 429, afterSeconds: 86_400 })
    expect(await processDelivery(d.deps, ref)).toBe('retrying')
    expect(d.queue.send).toHaveBeenCalledWith(ref, 900)
  })

  it('kills a permanent failure on the first attempt and copies it to the dead-letter queue', async () => {
    const d = deps({ kind: 'permanent', error: 'the destination answered 410', statusCode: 410 })
    expect(await processDelivery(d.deps, ref)).toBe('dead')
    expect(d.store.markDead).toHaveBeenCalledWith(claimed(), 1_000, 'the destination answered 410', 410)
    expect(d.deadLetters.send).toHaveBeenCalledWith(ref, 0)
    expect(d.queue.send).not.toHaveBeenCalled()
    expect(d.addMetric).toHaveBeenCalledWith('deliveriesDead', MetricUnit.Count, 1)
  })

  it('kills a delivery whose last attempt failed', async () => {
    const d = deps({ kind: 'retry', error: 'still 503' }, record({ attempts: 7 }))
    expect(await processDelivery(d.deps, ref)).toBe('dead')
    expect(d.store.markDead).toHaveBeenCalledWith(claimed(record({ attempts: 7 })), 1_000, 'still 503', undefined)
    expect(d.deadLetters.send).toHaveBeenCalledWith(ref, 0)
    expect(d.addMetric).toHaveBeenCalledWith('deliveriesDead', MetricUnit.Count, 1)
  })

  it('copies a dead delivery on a later pass when the first copy never landed', async () => {
    const d = deps({ kind: 'permanent', error: 'the destination answered 410', statusCode: 410 })
    d.deadLetters.send.mockRejectedValueOnce(new Error('SQS is unavailable'))
    await expect(processDelivery(d.deps, ref)).rejects.toThrow('SQS is unavailable')
    // the item is dead now, so the redelivered message meets the terminal skip; without a copy made there the
    // dead-letter depth alarm would never see this delivery at all
    expect(await processDelivery(d.deps, ref)).toBe('skipped')
    expect(d.deadLetters.send).toHaveBeenCalledTimes(2)
    expect(d.deadLetters.send).toHaveBeenLastCalledWith(ref, 0)
    // the first pass died inside recordOutcome before it logged anything, so this line is the only trace
    // that the delivery is dead - without it, nothing ever classifies this invocation as having seen a dead one
    expect(d.deps.log).toHaveBeenCalledWith('re-sent a dead-letter copy for a delivery already marked dead', {
      deliveryId: 'dlv_1',
    })
    // the first pass died before it reached the metric too, same as the log line above; the redelivery branch
    // is the only place either one is recorded for this delivery
    expect(d.addMetric).toHaveBeenCalledTimes(1)
    expect(d.addMetric).toHaveBeenCalledWith('deliveriesDead', MetricUnit.Count, 1)
  })

  it('treats a sender that threw as a retry rather than losing the delivery', async () => {
    const d = deps(new Error('unexpected'))
    expect(await processDelivery(d.deps, ref)).toBe('retrying')
    expect(d.store.scheduleRetry).toHaveBeenCalled()
  })

  it('leaves the outcome to whoever holds the delivery now rather than sending it twice', async () => {
    const outcomes: SendOutcome[] = [
      { kind: 'delivered' },
      { kind: 'retry', error: 'still 503' },
      { kind: 'permanent', error: 'the destination answered 410' },
    ]
    for (const outcome of outcomes) {
      const d = deps(outcome)
      // another sender's lease lands while this attempt is in flight, so the record step conflicts
      d.send.mockImplementationOnce(async () => {
        const held = d.items.get(itemKey)!
        d.items.set(itemKey, { ...held, version: held.version + 1 })
        return outcome
      })
      expect(await processDelivery(d.deps, ref)).toBe('skipped')
      expect(d.send).toHaveBeenCalledOnce()
      expect(d.queue.send).not.toHaveBeenCalled()
      expect(d.deadLetters.send).not.toHaveBeenCalled()
    }
  })

  it('skips a delivery that is already delivered or dead', async () => {
    for (const status of ['delivered', 'dead'] as const) {
      const d = deps({ kind: 'delivered' }, record({ status }))
      expect(await processDelivery(d.deps, ref)).toBe('skipped')
      expect(d.send).not.toHaveBeenCalled()
    }
  })

  it('skips a delivery that is gone', async () => {
    const d = deps({ kind: 'delivered' }, undefined)
    expect(await processDelivery(d.deps, ref)).toBe('skipped')
    expect(d.send).not.toHaveBeenCalled()
  })

  it('skips a delivery another sender claimed first, without sending twice', async () => {
    const d = deps({ kind: 'delivered' })
    d.store.claim.mockRejectedValueOnce(new DeliveryConflictError('dlv_1'))
    expect(await processDelivery(d.deps, ref)).toBe('skipped')
    expect(d.send).not.toHaveBeenCalled()
  })

  it("routes to the sender for the delivery's channel", async () => {
    const d = deps(
      { kind: 'delivered' },
      record({ channel: 'telegram', target: { channel: 'telegram', chatId: '-100' } }),
    )
    const telegram = vi.fn(async () => ({ kind: 'delivered' }) as SendOutcome)
    await processDelivery({ ...d.deps, senders: { ...d.deps.senders, telegram } }, ref)
    expect(telegram).toHaveBeenCalledOnce()
  })

  it('kills a delivery whose channel has no sender rather than looping', async () => {
    const stored = record({
      channel: 'sqs',
      target: { channel: 'sqs', queueArn: 'arn:aws:sqs:us-east-1:111122223333:q' },
    })
    const d = deps({ kind: 'delivered' }, stored)
    expect(await processDelivery({ ...d.deps, senders: {} }, ref)).toBe('dead')
    // the item has to leave the due index and the copy has to reach the queue, or the reaper picks this
    // delivery up again for an hour and the alarm never hears about it
    expect(d.store.markDead).toHaveBeenCalledWith(claimed(stored), 1_000, 'no sender for channel sqs')
    expect(d.deadLetters.send).toHaveBeenCalledWith(ref, 0)
    expect(d.items.get(itemKey)?.status).toBe('dead')
    // this path kills a delivery without ever reaching recordOutcome, so it has to count itself
    expect(d.addMetric).toHaveBeenCalledWith('deliveriesDead', MetricUnit.Count, 1)
  })
})

describe('fakeStore', () => {
  it('conflicts on a write to an item that is no longer there, the same as the real store', async () => {
    // the real store's ConditionExpression names a version attribute that an absent item doesn't have, so the
    // condition fails exactly as it would for a version mismatch; a fake that only checks the mismatch case
    // would let a write like this through and hide a bug the real store would catch
    const { store } = fakeStore()
    await expect(store.markDelivered(record(), 1_000)).rejects.toThrow(DeliveryConflictError)
  })
})

describe('processMessages', () => {
  it('handles every message and reports only the ones that threw', async () => {
    const d = deps({ kind: 'delivered' })
    const broken = {
      ...d.deps,
      store: {
        ...d.store,
        get: vi.fn(async () => {
          throw new Error('ProvisionedThroughputExceeded')
        }),
      },
    }
    const records = [
      { messageId: 'm1', body: JSON.stringify(ref) },
      { messageId: 'm2', body: 'not json' },
    ] as never
    const response = await processMessages(broken, records, () => DEADLINE_MARGIN_MS)
    // m1 could not be read and will be tried again; m2 can never be read and is not worth a retry
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }])
  })

  it('reports nothing when every message is handled', async () => {
    const d = deps({ kind: 'delivered' })
    const records = [{ messageId: 'm1', body: JSON.stringify(ref) }] as never
    expect(await processMessages(d.deps, records, () => DEADLINE_MARGIN_MS)).toEqual({ batchItemFailures: [] })
  })

  it('hands back the messages it has no time left to attempt', async () => {
    const d = deps({ kind: 'delivered' })
    const records = [
      { messageId: 'm1', body: JSON.stringify(ref) },
      { messageId: 'm2', body: 'not json' },
    ] as never
    const response = await processMessages(d.deps, records, () => DEADLINE_MARGIN_MS - 1)
    // m1 is untouched and comes back; m2 still parses into nothing, and no amount of time would change that
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }])
    expect(d.send).not.toHaveBeenCalled()
  })

  it('takes a message when a whole attempt still fits', async () => {
    const d = deps({ kind: 'delivered' })
    const records = [{ messageId: 'm1', body: JSON.stringify(ref) }] as never
    expect(await processMessages(d.deps, records, () => DEADLINE_MARGIN_MS)).toEqual({ batchItemFailures: [] })
    expect(d.send).toHaveBeenCalledOnce()
  })
})
