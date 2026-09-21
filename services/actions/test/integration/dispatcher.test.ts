import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLookup } from '../../src/lookup.js'
import { dispatchRecords, sweepDue } from '../../src/dispatcher.js'
import { keys } from '../../src/keys.js'
import { fakeQueue } from '../unit/fakes.js'
import { matchRow, streamRecord } from '../helpers/images.js'
import { startDynamo, startStore, type Harness } from '../helpers/store.js'

let dynamo: Awaited<ReturnType<typeof startDynamo>>
let h: Harness

beforeAll(async () => {
  dynamo = await startDynamo()
  h = await startStore(dynamo)
  await dynamo.doc.send(
    new PutCommand({
      TableName: h.tableName,
      Item: {
        PK: 'RULE#rule-1',
        SK: 'META',
        ruleId: 'rule-1',
        active: true,
        input: {
          chainId: 8453,
          addresses: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
          event: 'event Transfer(address indexed from, address indexed to, uint256 value)',
          confirmation: { mode: 'finalized' },
          actions: [{ type: 'webhook', url: 'https://example.com/hook' }],
        },
        createdAt: 'x',
        updatedAt: 'x',
      },
    }),
  )
}, 180_000)

afterAll(async () => {
  await dynamo.stop()
})

describe('against a real table', () => {
  it('creates a delivery once for a record delivered twice, and the reaper finishes an unenqueued one', async () => {
    const { queue, sent } = fakeQueue()
    const log = () => {}
    const deps = {
      store: h.store,
      lookup: createLookup(dynamo.doc, h.tableName),
      queue,
      now: () => new Date(1_000),
      log,
    }
    const row = matchRow({ status: 'final' })
    const record = streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })

    await dispatchRecords(deps, [record])
    await dispatchRecords(deps, [record])
    expect(sent).toHaveLength(1)

    const ref = sent[0]!.ref
    const stored = await h.store.get(ref)
    expect(stored?.status).toBe('queued')

    // the case a conditional put would otherwise hide for ever: the item exists, the message never arrived
    await h.store.scheduleRetry(await h.store.claim(stored!, 2_000, 0), 2_000, 2_000, 'the message was lost')
    sent.length = 0
    expect(await sweepDue(deps, 2_000 + 61_000, 10)).toEqual({ requeued: 1, dead: 0 })
    expect(sent).toHaveLength(1)
  })

  it('caches a rule read', async () => {
    let reads = 0
    const doc = {
      send: (command: unknown) => {
        reads++
        return dynamo.doc.send(command as never)
      },
    } as never
    const lookup = createLookup(doc, h.tableName, { ttlMs: 60_000, now: () => 1_000 })
    await lookup.rule('rule-1')
    await lookup.rule('rule-1')
    expect(reads).toBe(1)
  })
})
