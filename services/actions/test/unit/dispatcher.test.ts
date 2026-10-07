import { describe, expect, it, vi } from 'vitest'
import { dispatchRecords, MAX_ATTEMPTS, MAX_SWEEP_PAGES, sweepDue } from '../../src/dispatcher.js'
import type { CompiledRuleView } from '../../src/lookup.js'
import { keys, refOf } from '../../src/keys.js'
import { MAX_PAYLOAD_BYTES } from '../../src/records.js'
import type { DueCursor } from '../../src/store.js'
import { matchRow, streamRecord, txRow } from '../helpers/images.js'
import { fakeLookup, fakeQueue, fakeStore } from './fakes.js'

const webhookRule = (
  mode: 'fast' | 'finalized',
  actions: CompiledRuleView['actions'] = [
    { actionId: 'a_1111111111111111', action: { type: 'webhook', url: 'https://example.com/hook' } },
  ],
): CompiledRuleView => ({
  ruleId: 'rule-1',
  event: 'event Transfer(address indexed from, address indexed to, uint256 value)',
  eventName: 'Transfer',
  mode,
  actions,
})

const deps = (rules: Record<string, CompiledRuleView>, signers = {}) => {
  const { store, items } = fakeStore()
  const { queue, sent } = fakeQueue()
  const { queue: deadLetters, sent: dead } = fakeQueue()
  const log = vi.fn()
  return {
    deps: {
      store,
      lookup: fakeLookup(rules, signers),
      queue,
      deadLetters,
      now: () => new Date(1_000),
      log,
    },
    items,
    sent,
    dead,
    log,
  }
}

describe('matches', () => {
  it('creates one delivery per action and enqueues each of them', async () => {
    const rules = {
      'rule-1': webhookRule('finalized', [
        { actionId: 'a_1111111111111111', action: { type: 'webhook', url: 'https://example.com/a' } },
        { actionId: 'a_2222222222222222', action: { type: 'email', to: ['ops@example.com'] } },
      ]),
    }
    const d = deps(rules)
    const row = matchRow({ status: 'final' })
    const response = await dispatchRecords(d.deps, [
      streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row }),
    ])
    expect(response.batchItemFailures).toEqual([])
    expect(d.items.size).toBe(2)
    expect(d.sent).toHaveLength(2)
    expect(d.sent[0]!.delaySeconds).toBe(0)
    const delivery = [...d.items.values()][0]!
    expect(delivery.status).toBe('queued')
    expect(JSON.parse(delivery.payload).type).toBe('match.final')
    expect(JSON.parse(delivery.payload).data.eventName).toBe('Transfer')
  })

  // compileRule drops an action it would have refused and the lookup hands over what is left, so a rule that is
  // half valid still delivers its good half and nothing is created for the dropped one
  it('delivers the actions a half-valid rule kept, and nothing at all when every action was dropped', async () => {
    const row = matchRow({ status: 'final' })
    const record = streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })

    const half = deps({
      'rule-1': webhookRule('finalized', [
        { actionId: 'a_2222222222222222', action: { type: 'email', to: ['ops@example.com'] } },
      ]),
    })
    await dispatchRecords(half.deps, [record])
    expect([...half.items.values()].map((d) => d.channel)).toEqual(['email'])

    const none = deps({ 'rule-1': webhookRule('finalized', []) })
    const response = await dispatchRecords(none.deps, [record])
    expect(response.batchItemFailures).toEqual([])
    expect(none.items.size).toBe(0)
    expect(none.sent).toEqual([])
    expect(none.dead).toEqual([])
  })

  it('sends a provisional match only for a fast rule', async () => {
    const row = matchRow({ status: 'provisional' })
    const record = streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })
    const fast = deps({ 'rule-1': webhookRule('fast') })
    await dispatchRecords(fast.deps, [record])
    expect(fast.items.size).toBe(1)
    const slow = deps({ 'rule-1': webhookRule('finalized') })
    await dispatchRecords(slow.deps, [record])
    expect(slow.items.size).toBe(0)
  })

  it('sends a drop notice only for a fast rule', async () => {
    const before = matchRow({ status: 'provisional' })
    const after = matchRow({ status: 'dropped' })
    const record = streamRecord(
      'MODIFY',
      { PK: before.PK as string, SK: 'META' },
      { oldImage: before, newImage: after },
    )
    const fast = deps({ 'rule-1': webhookRule('fast') })
    await dispatchRecords(fast.deps, [record])
    expect(fast.items.size).toBe(1)
    const slow = deps({ 'rule-1': webhookRule('finalized') })
    await dispatchRecords(slow.deps, [record])
    expect(slow.items.size).toBe(0)
  })

  it('creates the same delivery once however often the record arrives', async () => {
    const d = deps({ 'rule-1': webhookRule('finalized') })
    const row = matchRow({ status: 'final' })
    const record = streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })
    await dispatchRecords(d.deps, [record])
    await dispatchRecords(d.deps, [record])
    await dispatchRecords(d.deps, [record])
    expect(d.items.size).toBe(1)
    // the message is sent once: a delivery that already exists is not re-enqueued from the stream
    expect(d.sent).toHaveLength(1)
  })

  it('skips a match whose rule is gone, and does not fail the batch', async () => {
    const d = deps({})
    const row = matchRow({ status: 'final' })
    const response = await dispatchRecords(d.deps, [
      streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row }),
    ])
    expect(response.batchItemFailures).toEqual([])
    expect(d.items.size).toBe(0)
    expect(d.log).toHaveBeenCalledWith('no rule for match', expect.anything(), 'warn')
  })

  it('skips a rule with no actions without writing anything', async () => {
    const d = deps({ 'rule-1': webhookRule('finalized', []) })
    const row = matchRow({ status: 'final' })
    await dispatchRecords(d.deps, [streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })])
    expect(d.items.size).toBe(0)
  })
})

describe('transactions', () => {
  const signers = {
    demo: { signerId: 'demo', webhooks: ['https://example.com/tx'], webhookSecretParameter: '/bw/secret' },
  }

  it('creates one delivery per signer webhook', async () => {
    const d = deps({}, signers)
    const row = txRow({ signerId: 'demo' })
    await dispatchRecords(d.deps, [streamRecord('INSERT', { PK: 'TX#tx-1', SK: 'META' }, { newImage: row })])
    expect(d.items.size).toBe(1)
    const delivery = [...d.items.values()][0]!
    expect(delivery.event).toBe('tx.queued')
    expect(delivery.target).toEqual({
      channel: 'webhook',
      url: 'https://example.com/tx',
      secretParameter: '/bw/secret',
    })
    expect(JSON.parse(delivery.payload).data.txId).toBe('tx-1')
  })

  it('gives the second tx.mined of a reorg its own delivery id', async () => {
    const d = deps({}, signers)
    const first = txRow({
      signerId: 'demo',
      status: 'mined',
      history: [
        { status: 'queued', at: 't0' },
        { status: 'submitted', at: 't1' },
        { status: 'mined', at: 't2' },
      ],
    })
    const second = txRow({
      signerId: 'demo',
      status: 'mined',
      history: [
        { status: 'queued', at: 't0' },
        { status: 'submitted', at: 't1' },
        { status: 'mined', at: 't2' },
        { status: 'submitted', at: 't3' },
        { status: 'mined', at: 't4' },
      ],
    })
    await dispatchRecords(d.deps, [streamRecord('INSERT', { PK: 'TX#tx-1', SK: 'META' }, { newImage: first })])
    await dispatchRecords(d.deps, [
      streamRecord('MODIFY', { PK: 'TX#tx-1', SK: 'META' }, { oldImage: first, newImage: second }),
    ])
    const mined = [...d.items.values()].filter((d) => d.event === 'tx.mined')
    expect(mined).toHaveLength(2)
    expect(new Set(mined.map((m) => m.deliveryId)).size).toBe(2)
  })

  it('writes nothing for a signer with no webhooks', async () => {
    const d = deps({}, { demo: { signerId: 'demo', webhooks: [] } })
    await dispatchRecords(d.deps, [
      streamRecord('INSERT', { PK: 'TX#tx-1', SK: 'META' }, { newImage: txRow({ signerId: 'demo' }) }),
    ])
    expect(d.items.size).toBe(0)
  })
})

describe('failures', () => {
  it('reports the first record DynamoDB refused and stops there', async () => {
    const d = deps({ 'rule-1': webhookRule('finalized') })
    const failing = {
      ...d.deps,
      store: {
        ...d.deps.store,
        create: async () => {
          throw new Error('ProvisionedThroughputExceededException')
        },
      },
    }
    const row = matchRow({ status: 'final' })
    const first = streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })
    const second = streamRecord(
      'INSERT',
      { PK: 'MATCH#0xff', SK: 'META' },
      { newImage: matchRow({ PK: 'MATCH#0xff', matchKey: '0xff', status: 'final' }) },
    )
    const response = await dispatchRecords(failing, [first, second])
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: first.dynamodb!.SequenceNumber }])
  })

  it('fails the whole batch when the record it must report has no sequence number', async () => {
    const d = deps({ 'rule-1': webhookRule('finalized') })
    const failing = {
      ...d.deps,
      store: {
        ...d.deps.store,
        create: async () => {
          throw new Error('ProvisionedThroughputExceededException')
        },
      },
    }
    const row = matchRow({ status: 'final' })
    const record = streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })
    delete record.dynamodb!.SequenceNumber
    // an empty identifier is a response Lambda refuses outright, so it must never be one of the shapes we emit
    await expect(dispatchRecords(failing, [record])).rejects.toThrow('ProvisionedThroughputExceededException')
  })

  it('does not report a record it simply could not read', async () => {
    const d = deps({})
    const response = await dispatchRecords(d.deps, [
      streamRecord('INSERT', { PK: 'CHAIN#1', SK: 'CURSOR' }, { newImage: { PK: 'CHAIN#1', SK: 'CURSOR' } }),
    ])
    expect(response.batchItemFailures).toEqual([])
  })
})

describe('a record no retry can fix', () => {
  const signers = { demo: { signerId: 'demo', webhooks: ['https://example.com/tx'] } }
  const good = () => {
    const row = matchRow({ status: 'final' })
    return streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })
  }

  it('skips a transaction whose sequence number is past the width of the key', async () => {
    const d = deps({ 'rule-1': webhookRule('finalized') }, signers)
    const poison = streamRecord(
      'INSERT',
      { PK: 'TX#tx-1', SK: 'META' },
      { newImage: txRow({ signerId: 'demo', historyBase: 10_000 }) },
    )
    const response = await dispatchRecords(d.deps, [poison, good()])
    expect(response.batchItemFailures).toEqual([])
    expect(d.log).toHaveBeenCalledWith('record skipped; nothing about it can succeed', expect.anything(), 'error')
    // the record behind the poison one still went through, which is the whole point
    expect(d.items.size).toBe(1)
  })

  it('skips a match whose payload is over the size cap', async () => {
    const d = deps({ 'rule-1': webhookRule('finalized') }, signers)
    const row = matchRow({ status: 'final', args: { from: 'x'.repeat(MAX_PAYLOAD_BYTES) } })
    const poison = streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })
    const response = await dispatchRecords(d.deps, [
      poison,
      streamRecord('INSERT', { PK: 'TX#tx-1', SK: 'META' }, { newImage: txRow({ signerId: 'demo' }) }),
    ])
    expect(response.batchItemFailures).toEqual([])
    expect(d.log).toHaveBeenCalledWith('record skipped; nothing about it can succeed', expect.anything(), 'error')
    expect(d.items.size).toBe(1)
    expect([...d.items.values()][0]!.event).toBe('tx.queued')
  })
})

describe('the reaper', () => {
  it('re-enqueues a delivery whose next attempt is past by more than the grace', async () => {
    const d = deps({ 'rule-1': webhookRule('finalized') })
    const row = matchRow({ status: 'final' })
    await dispatchRecords(d.deps, [streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })])
    d.sent.length = 0
    expect(await sweepDue(d.deps, 121_500, 10)).toEqual({ requeued: 1, dead: 0 })
    expect(d.sent).toHaveLength(1)
  })

  it('leaves a delivery that was queued inside the grace alone', async () => {
    const d = deps({ 'rule-1': webhookRule('finalized') })
    const row = matchRow({ status: 'final' })
    await dispatchRecords(d.deps, [streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })])
    d.sent.length = 0
    expect(await sweepDue(d.deps, 5_000, 10)).toEqual({ requeued: 0, dead: 0 })
    expect(d.sent).toHaveLength(0)
  })

  it('drains the oldest delivery first', async () => {
    const d = deps({
      'rule-1': webhookRule('finalized', [
        { actionId: 'a_1111111111111111', action: { type: 'webhook', url: 'https://example.com/a' } },
        { actionId: 'a_2222222222222222', action: { type: 'webhook', url: 'https://example.com/b' } },
        { actionId: 'a_3333333333333333', action: { type: 'webhook', url: 'https://example.com/c' } },
      ]),
    })
    const row = matchRow({ status: 'final' })
    await dispatchRecords(d.deps, [streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })])
    const [first, second, third] = [...d.items.values()]
    // the real store merges four shards on the due time, so the sweep always sees the backlog oldest first
    first!.nextAttemptAt = 300_000
    second!.nextAttemptAt = 100_000
    third!.nextAttemptAt = 200_000
    d.sent.length = 0
    expect(await sweepDue(d.deps, 360_000, 10)).toEqual({ requeued: 3, dead: 0 })
    expect(d.sent.map((s) => s.ref.sk)).toEqual(
      [second!, third!, first!].map((x) => keys.delivery(x.subject, x.actionId, x.event, x.seq).SK),
    )
  })

  it('logs a delivery another invocation requeued first rather than throwing', async () => {
    const d = deps({ 'rule-1': webhookRule('finalized') })
    const row = matchRow({ status: 'final' })
    await dispatchRecords(d.deps, [streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })])
    // what the sweep read, and then the item moving on underneath it: the version condition refuses the write
    const stale = { ...[...d.items.values()][0]! }
    for (const item of d.items.values()) item.version += 1
    const store = { ...d.deps.store, listDuePage: async () => ({ deliveries: [stale] }) }
    d.sent.length = 0
    expect(await sweepDue({ ...d.deps, store }, 121_500, 10)).toEqual({ requeued: 0, dead: 0 })
    expect(d.sent).toHaveLength(0)
    expect(d.log).toHaveBeenCalledWith('could not process a due delivery', expect.anything(), 'warn')
  })

  it('walks the backlog with the cursor rather than reading the first page again', async () => {
    const d = deps({
      'rule-1': webhookRule('finalized', [
        { actionId: 'a_1111111111111111', action: { type: 'webhook', url: 'https://example.com/a' } },
        { actionId: 'a_2222222222222222', action: { type: 'webhook', url: 'https://example.com/b' } },
      ]),
    })
    const row = matchRow({ status: 'final' })
    await dispatchRecords(d.deps, [streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })])
    d.sent.length = 0
    const cursors: (DueCursor | undefined)[] = []
    const store = {
      ...d.deps.store,
      listDuePage: (nowMs: number, limit: number, cursor?: DueCursor) => {
        cursors.push(cursor)
        return d.deps.store.listDuePage(nowMs, limit, cursor)
      },
    }
    // a limit of one puts the second delivery on a second page, which is only reached by feeding the cursor back
    expect(await sweepDue({ ...d.deps, store }, 121_500, 1)).toEqual({ requeued: 2, dead: 0 })
    expect(cursors).toHaveLength(2)
    expect(cursors[0]).toBeUndefined()
    expect(cursors[1]).toBeDefined()
    expect(new Set(d.sent.map((s) => s.ref.sk)).size).toBe(2)
  })

  it('stops at the page cap when the cursor never runs out', async () => {
    const d = deps({})
    let pages = 0
    const store = {
      ...d.deps.store,
      // a backlog that never drains, which is what the cap is there for: the sweep is on a schedule and has to end
      listDuePage: async () => {
        pages++
        return { deliveries: [], cursor: { 0: { page: pages } } }
      },
    }
    expect(await sweepDue({ ...d.deps, store }, 121_500, 10)).toEqual({ requeued: 0, dead: 0 })
    expect(pages).toBe(MAX_SWEEP_PAGES)
  })

  it('kills a delivery that has already used every attempt, so nothing loops', async () => {
    const d = deps({ 'rule-1': webhookRule('finalized') })
    const row = matchRow({ status: 'final' })
    await dispatchRecords(d.deps, [streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })])
    for (const item of d.items.values()) item.attempts = MAX_ATTEMPTS
    d.sent.length = 0
    expect(await sweepDue(d.deps, 121_500, 10)).toEqual({ requeued: 0, dead: 1 })
    expect(d.sent).toHaveLength(0)
    const item = [...d.items.values()][0]!
    expect(item.status).toBe('dead')
    // dead has to mean the same on both paths, or a delivery exhausted by crashes dies where the alarm that
    // watches the dead-letter queue's depth cannot see it
    expect(d.dead).toEqual([{ ref: refOf(item), delaySeconds: 0 }])
  })

  it('leaves a dead delivery due when its dead-letter copy fails, so the next sweep finishes it', async () => {
    const d = deps({ 'rule-1': webhookRule('finalized') })
    const row = matchRow({ status: 'final' })
    await dispatchRecords(d.deps, [streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })])
    for (const item of d.items.values()) item.attempts = MAX_ATTEMPTS
    d.sent.length = 0
    const flaky = { send: vi.fn().mockRejectedValueOnce(new Error('SQS is unavailable')).mockResolvedValue(undefined) }

    // the copy fails on the first sweep; if markDead had already committed, the delivery would have left the
    // due index with no pointer in the dead-letter queue, and no later sweep would ever see it again
    expect(await sweepDue({ ...d.deps, deadLetters: flaky }, 121_500, 10)).toEqual({ requeued: 0, dead: 0 })
    expect([...d.items.values()][0]!.status).not.toBe('dead')
    expect(d.log).toHaveBeenCalledWith('could not process a due delivery', expect.anything(), 'warn')

    // still due, so the next sweep tries both steps again and this time the copy lands
    expect(await sweepDue({ ...d.deps, deadLetters: flaky }, 121_500, 10)).toEqual({ requeued: 0, dead: 1 })
    expect([...d.items.values()][0]!.status).toBe('dead')
    expect(flaky.send).toHaveBeenCalledTimes(2)
  })
})
