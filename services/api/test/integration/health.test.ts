import { CreateQueueCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMoto } from '../../../actions/test/helpers/store.js'
import { MonitorStore } from '../../../monitor/src/store.js'
import { handleHealth } from '../../src/health.js'

const WRITTEN = new Date('2026-09-24T12:00:00.000Z')

let dynamo: Dynamo
let moto: Awaited<ReturnType<typeof startMoto>>
let table: string
let queues: { delivery: string; deadLetter: string; streamFailure: string }

// leaves `sent - taken` messages visible and `taken` in flight, so every queue reads back its own pair of numbers
async function fill(name: string, sent: number, taken: number): Promise<string> {
  const url = (await moto.sqs.send(new CreateQueueCommand({ QueueName: name }))).QueueUrl!
  for (let i = 0; i < sent; i++) {
    await moto.sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: `${name}-${i}` }))
  }
  let received = 0
  while (received < taken) {
    const { Messages = [] } = await moto.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: taken - received, VisibilityTimeout: 600 }),
    )
    received += Messages.length
  }
  return url
}

beforeAll(async () => {
  ;[dynamo, moto] = await Promise.all([startDynamo(), startMoto()])
  table = await dynamo.newTable()
  queues = {
    delivery: await fill('deliveries', 4, 1),
    deadLetter: await fill('deliveries-dlq', 2, 0),
    streamFailure: await fill('stream-failures', 7, 2),
  }
}, 180_000)

afterAll(async () => {
  await Promise.all([dynamo?.stop(), moto?.stop()])
})

describe('health against the cursor the monitor writes and the queues SQS holds', () => {
  it("reads the blocks and the write time from the monitor's own saveCursor, and each queue's own depth", async () => {
    // the monitor's store, clock and all, so the row is exactly what a running poller leaves behind
    const monitor = new MonitorStore(dynamo.doc, table, () => WRITTEN)
    const created = await monitor.saveCursor(8453, { durableBlock: 19_000_000, fastBlock: 19_000_012, version: 0 })
    await monitor.saveCursor(8453, { ...created, durableBlock: 19_000_005 })

    const result = await handleHealth({
      doc: dynamo.doc,
      sqs: moto.sqs,
      table,
      chainIds: [8453, 42161],
      queues,
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
      queues: {
        delivery: { visible: 3, inFlight: 1 },
        deadLetter: { visible: 2, inFlight: 0 },
        streamFailure: { visible: 5, inFlight: 2 },
      },
    })
  })
})
