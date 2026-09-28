import { describe, expect, it, vi } from 'vitest'
import { DeliveryConflictError } from '../../src/store.js'
import { keys } from '../../src/keys.js'
import { processDelivery, processMessages } from '../../src/sender.js'
import type { DeliveryRecord, DeliveryRef } from '../../src/records.js'
import type { SendOutcome } from '../../src/senders/types.js'

const ref: DeliveryRef = { subject: 'MATCH#0x1', sk: keys.delivery('MATCH#0x1', 'a_1', 'match.final', 0).SK }

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

// a default parameter substitutes whenever the argument is undefined, not only when it is omitted, so it
// cannot tell "use the default record" apart from "the delivery is gone" (also undefined); a rest parameter,
// read by its length, can
const deps = (outcome: SendOutcome | Error, ...storedArgs: [DeliveryRecord | undefined] | []) => {
  const state = { current: storedArgs.length > 0 ? storedArgs[0] : record() }
  const store = {
    get: vi.fn(async () => state.current),
    claim: vi.fn(async (d: DeliveryRecord, nowMs: number) => {
      const next = {
        ...d,
        status: 'delivering' as const,
        attempts: d.attempts + 1,
        lastAttemptAt: nowMs,
        version: d.version + 1,
      }
      state.current = next
      return next
    }),
    markDelivered: vi.fn(async (d: DeliveryRecord) => ({ ...d, status: 'delivered' as const })),
    scheduleRetry: vi.fn(async (d: DeliveryRecord) => ({ ...d, status: 'failed' as const })),
    markDead: vi.fn(async (d: DeliveryRecord) => ({ ...d, status: 'dead' as const })),
  }
  const queue = { send: vi.fn(async () => {}) }
  const deadLetters = { send: vi.fn(async () => {}) }
  const send = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome
    return outcome
  })
  return {
    deps: {
      store: store as never,
      queue,
      deadLetters,
      senders: { webhook: send, email: send, telegram: send, relay: send, sqs: send, lambda: send },
      secrets: { read: async () => ['s'] },
      now: () => 1_000,
      log: vi.fn(),
      random: () => 0.5,
    },
    store,
    queue,
    deadLetters,
    send,
    state,
  }
}

describe('processDelivery', () => {
  it('claims, sends and marks delivered', async () => {
    const d = deps({ kind: 'delivered', statusCode: 204 })
    expect(await processDelivery(d.deps, ref)).toBe('delivered')
    expect(d.store.claim).toHaveBeenCalledOnce()
    expect(d.send).toHaveBeenCalledOnce()
    expect(d.store.markDelivered).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1 }), 1_000, 204)
    expect(d.queue.send).not.toHaveBeenCalled()
    expect(d.deadLetters.send).not.toHaveBeenCalled()
  })

  it('schedules the next attempt and enqueues it with a delay', async () => {
    const d = deps({ kind: 'retry', error: 'the destination answered 503', statusCode: 503 })
    expect(await processDelivery(d.deps, ref)).toBe('retrying')
    expect(d.store.scheduleRetry).toHaveBeenCalledWith(
      expect.anything(),
      1_000,
      1_000 + 10_000,
      'the destination answered 503',
      503,
    )
    expect(d.queue.send).toHaveBeenCalledWith(ref, 10)
  })

  it('kills a permanent failure on the first attempt and copies it to the dead-letter queue', async () => {
    const d = deps({ kind: 'permanent', error: 'the destination answered 410', statusCode: 410 })
    expect(await processDelivery(d.deps, ref)).toBe('dead')
    expect(d.store.markDead).toHaveBeenCalledWith(expect.anything(), 1_000, 'the destination answered 410', 410)
    expect(d.deadLetters.send).toHaveBeenCalledWith(ref, 0)
    expect(d.queue.send).not.toHaveBeenCalled()
  })

  it('kills a delivery whose last attempt failed', async () => {
    const d = deps({ kind: 'retry', error: 'still 503' }, record({ attempts: 7 }))
    expect(await processDelivery(d.deps, ref)).toBe('dead')
    expect(d.store.markDead).toHaveBeenCalled()
    expect(d.deadLetters.send).toHaveBeenCalled()
  })

  it('treats a sender that threw as a retry rather than losing the delivery', async () => {
    const d = deps(new Error('unexpected'))
    expect(await processDelivery(d.deps, ref)).toBe('retrying')
    expect(d.store.scheduleRetry).toHaveBeenCalled()
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
    await processDelivery({ ...d.deps, senders: { ...d.deps.senders, telegram } } as never, ref)
    expect(telegram).toHaveBeenCalledOnce()
  })

  it('kills a delivery whose channel has no sender rather than looping', async () => {
    const d = deps(
      { kind: 'delivered' },
      record({ channel: 'sqs', target: { channel: 'sqs', queueArn: 'arn:aws:sqs:us-east-1:111122223333:q' } }),
    )
    const outcome = await processDelivery({ ...d.deps, senders: {} } as never, ref)
    expect(outcome).toBe('dead')
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
    const response = await processMessages(broken as never, records)
    // m1 could not be read and will be tried again; m2 can never be read and is not worth a retry
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }])
  })

  it('reports nothing when every message is handled', async () => {
    const d = deps({ kind: 'delivered' })
    const records = [{ messageId: 'm1', body: JSON.stringify(ref) }] as never
    expect(await processMessages(d.deps, records)).toEqual({ batchItemFailures: [] })
  })
})
