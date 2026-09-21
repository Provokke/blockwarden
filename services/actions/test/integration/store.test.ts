import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { DUE_SHARDS, keys } from '../../src/keys.js'
import type { DeliveryRecord } from '../../src/records.js'
import { DeliveryConflictError, REAPER_GRACE_MS, type DeadCursor, type DueCursor } from '../../src/store.js'
import { newDelivery, startDynamo, startStore, type Harness } from '../helpers/store.js'
import { allDead } from '../../scripts/lib.js'

// Every non-terminal delivery in this table shares the due index, so listDue always sees what earlier tests left
// behind. Assert over the deliveries the test itself created, never over a whole page, or a later test that adds
// another pending delivery turns the assertion vacuous without failing.

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

const refOf = (d: DeliveryRecord) => ({
  subject: d.subject,
  sk: keys.delivery(d.subject, d.actionId, d.event, d.seq).SK,
})

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
    expect(Item?.GSI2PK).toBe(keys.dueDeliveries(keys.dueShard(delivery.deliveryId)))
    expect(Item?.GSI2PK).toMatch(/^DELIVERY#DUE#[0-3]$/)
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

  it('moves a queued delivery out of the immediate due window', async () => {
    const delivery = newDelivery({ subject: keys.matchSubject('0x14') })
    const created = (await h.store.create(delivery, at(1_000)))!
    const queued = await h.store.markQueued(created, 1_100)
    expect(queued.nextAttemptAt).toBe(1_100 + REAPER_GRACE_MS)
    // the reaper sweeps what fell due a grace ago; a sweep right after queuing must not send the same message again
    expect((await h.store.listDue(1_100, 10)).map((d) => d.deliveryId)).not.toContain(delivery.deliveryId)
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
    // the previous life's first attempt would make every latency measured on the redriven delivery wrong
    expect(reset.firstAttemptAt).toBeUndefined()
    expect((await h.store.get(refOf(reset)))?.firstAttemptAt).toBeUndefined()
    expect((await h.store.listDead(10)).map((d) => d.deliveryId)).not.toContain(delivery.deliveryId)
    expect((await h.store.listDue(10_000, 10)).map((d) => d.deliveryId)).toContain(delivery.deliveryId)
  })
})

describe('listDue', () => {
  it('returns the oldest first and stops at the limit', async () => {
    const subject = keys.matchSubject('0x30')
    const mine = new Set<string>()
    for (const seq of [0, 1, 2]) {
      const delivery = newDelivery({ subject, event: 'match.final', seq })
      mine.add(delivery.deliveryId)
      const created = (await h.store.create(delivery, at(1_000 + seq))!)!
      await h.store.scheduleRetry(await h.store.claim(created, 2_000, 60_000), 2_000, 5_000 - seq, 'x')
    }
    expect(await h.store.listDue(6_000, 2)).toHaveLength(2)
    const due = (await h.store.listDue(6_000, 100)).filter((d) => mine.has(d.deliveryId))
    expect(due.map((d) => d.nextAttemptAt)).toEqual([4_998, 4_999, 5_000])
  })

  it('spreads the deliveries over the shards and merges them back in due order', async () => {
    const subject = keys.matchSubject('0x31')
    const mine = new Set<string>()
    const partitions = new Set<unknown>()
    for (const seq of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const delivery = newDelivery({ subject, event: 'match.final', seq })
      mine.add(delivery.deliveryId)
      const created = (await h.store.create(delivery, at(1_000)))!
      await h.store.scheduleRetry(await h.store.claim(created, 2_000, 60_000), 2_000, 100_000 - seq, 'x')
      const { Item } = await h.dynamo.doc.send(
        new GetCommand({
          TableName: h.tableName,
          Key: keys.delivery(subject, delivery.actionId, delivery.event, seq),
        }),
      )
      partitions.add(Item?.GSI2PK)
    }
    expect(partitions.size).toBeGreaterThan(1)
    const due = (await h.store.listDue(100_000, 100)).filter((d) => mine.has(d.deliveryId))
    expect(due.map((d) => d.nextAttemptAt)).toEqual([99_993, 99_994, 99_995, 99_996, 99_997, 99_998, 99_999, 100_000])
    // the limit holds over the merge, not over each shard
    expect(await h.store.listDue(100_000, 3)).toHaveLength(3)
  })

  it('leaves a terminal delivery in no shard at all', async () => {
    const delivery = newDelivery({ subject: keys.matchSubject('0x32') })
    const created = (await h.store.create(delivery, at(1_000)))!
    await h.store.markDelivered(await h.store.claim(created, 2_000, 60_000), 2_500, 204)
    for (let shard = 0; shard < DUE_SHARDS; shard++) {
      const { Items } = await h.dynamo.doc.send(
        new QueryCommand({
          TableName: h.tableName,
          IndexName: 'GSI2',
          KeyConditionExpression: 'GSI2PK = :pk',
          ExpressionAttributeValues: { ':pk': keys.dueDeliveries(shard) },
        }),
      )
      expect((Items ?? []).map((i) => i.deliveryId)).not.toContain(delivery.deliveryId)
    }
  })
})

describe('paging', () => {
  it('walks the due backlog with the cursor instead of handing back the same oldest page', async () => {
    const subject = keys.matchSubject('0x40')
    const mine: string[] = []
    for (const seq of [0, 1, 2, 3, 4, 5]) {
      const delivery = newDelivery({ subject, event: 'match.final', seq })
      mine.push(delivery.deliveryId)
      const created = (await h.store.create(delivery, at(1_000)))!
      await h.store.scheduleRetry(await h.store.claim(created, 2_000, 60_000), 2_000, 200_000 + seq, 'x')
    }
    const seen: string[] = []
    let cursor: DueCursor | undefined
    for (let page = 0; page < 50; page++) {
      const next = await h.store.listDuePage(300_000, 2, cursor)
      seen.push(...next.deliveries.map((d) => d.deliveryId))
      cursor = next.cursor
      if (!cursor) break
    }
    expect(cursor).toBeUndefined()
    // nothing read twice, nothing behind the first page missed, and the due order held across the pages
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.filter((id) => mine.includes(id))).toEqual(mine)
  })

  it('pages the dead list the same way', async () => {
    const subject = keys.matchSubject('0x41')
    const mine: string[] = []
    for (const seq of [0, 1, 2]) {
      const delivery = newDelivery({ subject, event: 'match.final', seq })
      mine.push(delivery.deliveryId)
      const created = (await h.store.create(delivery, at(1_000 + seq)))!
      await h.store.markDead(await h.store.claim(created, 2_000, 60_000), 2_500, 'gone', 410)
    }
    const seen: string[] = []
    let cursor: DeadCursor | undefined
    for (let page = 0; page < 50; page++) {
      const next = await h.store.listDeadPage(2, cursor)
      seen.push(...next.deliveries.map((d) => d.deliveryId))
      cursor = next.cursor
      if (!cursor) break
    }
    expect(cursor).toBeUndefined()
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.filter((id) => mine.includes(id))).toEqual(mine)
  })

  it('hands the redrive script the whole dead list, not its first page', async () => {
    const subject = keys.matchSubject('0x42')
    const mine: string[] = []
    for (const seq of [0, 1, 2]) {
      const delivery = newDelivery({ subject, event: 'match.final', seq })
      mine.push(delivery.deliveryId)
      const created = (await h.store.create(delivery, at(3_000 + seq)))!
      await h.store.markDead(await h.store.claim(created, 4_000, 60_000), 4_500, 'gone', 410)
    }
    // a page of one, so a walk that stopped at the first page would answer with one delivery and the script
    // would report the other two as deliveries that do not exist
    const seen = (await allDead(h.store, 1)).map((d) => d.deliveryId)
    expect(seen.filter((id) => mine.includes(id))).toEqual(mine)
  })
})

describe('reading a delivery back', () => {
  it('gets one by the key keys.delivery builds, without the index attributes', async () => {
    const delivery = newDelivery({ subject: keys.matchSubject('0x50') })
    const created = (await h.store.create(delivery, at(1_000)))!
    const got = await h.store.get(refOf(created))
    expect(got).toEqual(created)
    for (const attribute of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK']) {
      expect(got).not.toHaveProperty(attribute)
    }
    expect(await h.store.get({ subject: delivery.subject, sk: `${refOf(created).sk}#no` })).toBeUndefined()
  })

  it('clears the last error when a later attempt succeeds', async () => {
    const delivery = newDelivery({ subject: keys.matchSubject('0x51') })
    const created = (await h.store.create(delivery, at(1_000)))!
    const failed = await h.store.scheduleRetry(
      await h.store.claim(created, 2_000, 60_000),
      2_000,
      3_000,
      'the destination answered 503',
      503,
    )
    const delivered = await h.store.markDelivered(await h.store.claim(failed, 4_000, 60_000), 4_500, 200)
    expect(delivered.lastError).toBeUndefined()
    expect(delivered.nextAttemptAt).toBeUndefined()
    expect(await h.store.get(refOf(delivered))).toEqual(delivered)
  })

  it('drops the next attempt time when a delivery dies', async () => {
    const delivery = newDelivery({ subject: keys.matchSubject('0x52') })
    const created = (await h.store.create(delivery, at(1_000)))!
    const dead = await h.store.markDead(await h.store.claim(created, 2_000, 60_000), 2_500, 'gone', 410)
    expect(dead.nextAttemptAt).toBeUndefined()
    expect((await h.store.get(refOf(dead)))?.nextAttemptAt).toBeUndefined()
  })

  it('lists the dead oldest first and stops at the limit', async () => {
    const subject = keys.matchSubject('0x53')
    const mine: string[] = []
    // written out of order, so the order below is the index's doing and not the order of the writes
    for (const seq of [2, 0, 1]) {
      const delivery = newDelivery({ subject, event: 'match.final', seq })
      mine.push(delivery.deliveryId)
      const created = (await h.store.create(delivery, at(50_000 + seq)))!
      await h.store.markDead(await h.store.claim(created, 60_000, 0), 60_000, 'gone', 410)
    }
    expect(await h.store.listDead(1)).toHaveLength(1)
    const dead = (await h.store.listDead(100)).filter((d) => mine.includes(d.deliveryId))
    expect(dead.map((d) => d.createdAt)).toEqual([
      at(50_000).toISOString(),
      at(50_001).toISOString(),
      at(50_002).toISOString(),
    ])
  })
})
