import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MonitorStore } from '../../../monitor/src/store.js'
import { handleHealth, type HealthDeps } from '../../src/health.js'

const QUEUE = 'https://sqs.eu-west-2.amazonaws.com/123456789012/deliveries'
const WRITTEN = new Date('2026-09-24T12:00:00.000Z')

let dynamo: Dynamo
let table: string

beforeAll(async () => {
  dynamo = await startDynamo()
  table = await dynamo.newTable()
}, 180_000)

afterAll(async () => {
  await dynamo?.stop()
})

// answers only the queue it was asked about; this test is about the cursor row, the queue half is unit-tested
const sqs: HealthDeps['sqs'] = {
  async send(command) {
    if (!(command instanceof GetQueueAttributesCommand) || command.input.QueueUrl !== QUEUE) throw new Error('no queue')
    return { Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0' } }
  },
}

describe('health against the cursor the monitor writes', () => {
  it("reads the blocks and the write time from the monitor's own saveCursor", async () => {
    // the monitor's store, clock and all, so the row is exactly what a running poller leaves behind
    const monitor = new MonitorStore(dynamo.doc, table, () => WRITTEN)
    const created = await monitor.saveCursor(8453, { durableBlock: 19_000_000, fastBlock: 19_000_012, version: 0 })
    await monitor.saveCursor(8453, { ...created, durableBlock: 19_000_005 })

    const result = await handleHealth({
      doc: dynamo.doc,
      sqs,
      table,
      chainIds: [8453, 42161],
      queues: { delivery: QUEUE },
      now: () => WRITTEN.getTime() + 90_000,
      log: () => {},
    })

    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      chains: {
        8453: { durableBlock: '19000005', fastBlock: '19000012', cursorAgeSeconds: 90 },
        // no poller has written this chain's cursor yet
        42161: { durableBlock: null, fastBlock: null, cursorAgeSeconds: null },
      },
      queues: { delivery: { visible: 0, inFlight: 0 } },
    })
  })
})
