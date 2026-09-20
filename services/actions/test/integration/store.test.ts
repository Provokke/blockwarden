import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { keys } from '../../src/keys.js'
import { DeliveryConflictError } from '../../src/store.js'
import { newDelivery, startDynamo, startStore, type Harness } from '../helpers/store.js'

let dynamo: Awaited<ReturnType<typeof startDynamo>>
let h: Harness

beforeAll(async () => {
  dynamo = await startDynamo()
  h = await startStore(dynamo)
}, 180_000)

afterAll(async () => {
  await dynamo.stop()
})

const at = (ms: number) => new Date(ms)

describe('create', () => {
  it('writes the delivery once and refuses the second write', async () => {
    const delivery = newDelivery({ subject: keys.matchSubject('0x01') })
    const created = await h.store.create(delivery, at(1_000))
    expect(created?.status).toBe('pending')
    expect(created?.attempts).toBe(0)
    expect(created?.version).toBe(0)
    expect(await h.store.create(delivery, at(2_000))).toBeUndefined()
  })

  it('puts a pending delivery in the due index and nothing in the dead index', async () => {
    const delivery = newDelivery({ subject: keys.matchSubject('0x02') })
    await h.store.create(delivery, at(1_000))
    const { Item } = await h.dynamo.doc.send(
      new GetCommand({
        TableName: h.tableName,
        Key: keys.delivery(delivery.subject, delivery.actionId, delivery.event, delivery.seq),
      }),
    )
    expect(Item?.GSI2PK).toBe('DELIVERY#DUE')
    expect(Item?.GSI2SK).toBe(1_000)
    expect(Item?.GSI1PK).toBeUndefined()
    expect(Item?.expiresAt).toBe(1 + 30 * 24 * 60 * 60)
  })

  it('refuses a payload above the limit rather than storing it', async () => {
    const delivery = newDelivery({ subject: keys.matchSubject('0x03'), payload: 'x'.repeat(64 * 1024 + 1) })
    await expect(h.store.create(delivery, at(1_000))).rejects.toThrow('payload is larger than')
  })
})

describe('the attempt cycle', () => {
  it('claims, delivers and leaves the due index', async () => {
    const delivery = newDelivery({ subject: keys.matchSubject('0x10') })
    const created = (await h.store.create(delivery, at(1_000)))!
    const queued = await h.store.markQueued(created, 1_100)
    expect(queued.status).toBe('queued')
    const claimed = await h.store.claim(queued, 2_000, 60_000)
    expect(claimed.status).toBe('delivering')
    expect(claimed.attempts).toBe(1)
    expect(claimed.firstAttemptAt).toBe(2_000)
    expect(claimed.nextAttemptAt).toBe(62_000)
    const delivered = await h.store.markDelivered(claimed, 2_500, 204)
    expect(delivered.status).toBe('delivered')
    expect(delivered.lastStatusCode).toBe(204)
    expect(await h.store.listDue(10 ** 12, 10)).not.toContainEqual(
      expect.objectContaining({ deliveryId: delivery.deliveryId }),
    )
  })

  it('schedules a retry and comes back in the due index', async () => {
    const delivery = newDelivery({ subject: keys.matchSubject('0x11') })
    const created = (await h.store.create(delivery, at(1_000)))!
    const claimed = await h.store.claim(created, 2_000, 60_000)
    const retry = await h.store.scheduleRetry(claimed, 2_500, 12_500, 'the destination answered 503', 503)
    expect(retry.status).toBe('failed')
    expect(retry.nextAttemptAt).toBe(12_500)
    expect(retry.lastError).toBe('the destination answered 503')
    const due = await h.store.listDue(13_000, 10)
    expect(due.map((d) => d.deliveryId)).toContain(delivery.deliveryId)
    expect(await h.store.listDue(12_000, 10)).not.toContainEqual(
      expect.objectContaining({ deliveryId: delivery.deliveryId }),
    )
  })

  it('cuts a long error to 256 characters and says it did', async () => {
    const delivery = newDelivery({ subject: keys.matchSubject('0x12') })
    const created = (await h.store.create(delivery, at(1_000)))!
    const claimed = await h.store.claim(created, 2_000, 60_000)
    const retry = await h.store.scheduleRetry(claimed, 2_500, 12_500, 'x'.repeat(5_000))
    expect(retry.lastError).toHaveLength(259)
    expect(retry.lastError?.endsWith('...')).toBe(true)
  })

  it('refuses a write against a version that has moved', async () => {
    const delivery = newDelivery({ subject: keys.matchSubject('0x13') })
    const created = (await h.store.create(delivery, at(1_000)))!
    await h.store.claim(created, 2_000, 60_000)
    // a second sender that read the same item before the first claimed it
    await expect(h.store.claim(created, 2_100, 60_000)).rejects.toBeInstanceOf(DeliveryConflictError)
  })
})

describe('dead letters', () => {
  it('marks a delivery dead, lists it and takes it out of the due index', async () => {
    const delivery = newDelivery({ subject: keys.matchSubject('0x20') })
    const created = (await h.store.create(delivery, at(1_000)))!
    const claimed = await h.store.claim(created, 2_000, 60_000)
    const dead = await h.store.markDead(claimed, 2_500, 'the destination answered 410', 410)
    expect(dead.status).toBe('dead')
    expect((await h.store.listDead(10)).map((d) => d.deliveryId)).toContain(delivery.deliveryId)
    expect(await h.store.listDue(10 ** 12, 100)).not.toContainEqual(
      expect.objectContaining({ deliveryId: delivery.deliveryId }),
    )
  })

  it('a redrive puts it back as pending with no attempts and out of the dead list', async () => {
    const delivery = newDelivery({ subject: keys.matchSubject('0x21') })
    const created = (await h.store.create(delivery, at(1_000)))!
    const claimed = await h.store.claim(created, 2_000, 60_000)
    const dead = await h.store.markDead(claimed, 2_500, 'gone', 410)
    const reset = await h.store.reset(dead, 9_000)
    expect(reset.status).toBe('pending')
    expect(reset.attempts).toBe(0)
    expect(reset.lastError).toBeUndefined()
    expect((await h.store.listDead(10)).map((d) => d.deliveryId)).not.toContain(delivery.deliveryId)
    expect((await h.store.listDue(10_000, 10)).map((d) => d.deliveryId)).toContain(delivery.deliveryId)
  })
})

describe('listDue', () => {
  it('returns the oldest first and stops at the limit', async () => {
    const subject = keys.matchSubject('0x30')
    for (const seq of [0, 1, 2]) {
      const delivery = newDelivery({ subject, event: 'match.final', seq })
      const created = (await h.store.create(delivery, at(1_000 + seq))!)!
      await h.store.scheduleRetry(await h.store.claim(created, 2_000, 60_000), 2_000, 5_000 - seq, 'x')
    }
    const due = await h.store.listDue(6_000, 2)
    expect(due).toHaveLength(2)
    expect(due[0]!.nextAttemptAt!).toBeLessThanOrEqual(due[1]!.nextAttemptAt!)
  })
})
