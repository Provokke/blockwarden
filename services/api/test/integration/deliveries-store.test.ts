import type { APIGatewayProxyEventV2, SQSRecord } from 'aws-lambda'
import { CreateQueueCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs'
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deliveryId } from '../../../actions/src/ids.js'
import { keys } from '../../../actions/src/keys.js'
import type { DeliveryRecord } from '../../../actions/src/records.js'
import { processMessages, type SenderPipelineDeps } from '../../../actions/src/sender.js'
import { DeliveryStore as ActionsDeliveryStore } from '../../../actions/src/store.js'
import { newDelivery, startMoto } from '../../../actions/test/helpers/store.js'
import { encodeCursor } from '../../src/http.js'
import { handleListDeliveries, handleRedrive, type DeliveryDeps } from '../../src/deliveries.js'
import { createStore, type ApiStore, type DeliveryRef } from '../../src/store.js'

let dynamo: Dynamo
let moto: Awaited<ReturnType<typeof startMoto>>
let actionsStore: ActionsDeliveryStore
let apiStore: ApiStore
let table: string
let queueUrl: string

beforeAll(async () => {
  ;[dynamo, moto] = await Promise.all([startDynamo(), startMoto()])
  table = await dynamo.newTable()
  actionsStore = new ActionsDeliveryStore(dynamo.doc, table)
  apiStore = createStore({ doc: dynamo.doc, table })
  queueUrl = (await moto.sqs.send(new CreateQueueCommand({ QueueName: 'deliveries' }))).QueueUrl!
}, 180_000)

afterAll(async () => {
  await Promise.all([dynamo?.stop(), moto?.stop()])
})

// narrowed to the real event type rather than to `never`, same helper as rules-store.test.ts's apiEvent
function apiEvent(over: Partial<APIGatewayProxyEventV2>): APIGatewayProxyEventV2 {
  return { version: '2.0', headers: {}, ...over } as APIGatewayProxyEventV2
}

function deps(): DeliveryDeps {
  return {
    store: apiStore,
    now: () => 3_000,
    queue: {
      async send(body) {
        await moto.sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }))
      },
    },
  }
}

function refOf(delivery: DeliveryRecord): DeliveryRef {
  return {
    subject: delivery.subject,
    sk: keys.delivery(delivery.subject, delivery.actionId, delivery.event, delivery.seq).SK,
  }
}

// writes a delivery through the actions service's own store (the only writer real infrastructure ever uses),
// then kills it the same way the sender does - never by poking status onto a row by hand
async function deadDelivery(subject: string): Promise<DeliveryRecord> {
  const created = await actionsStore.create(newDelivery({ subject }), new Date(1_000))
  if (!created) throw new Error('delivery already existed')
  return actionsStore.markDead(created, 2_000, 'the destination answered 500', 500)
}

// same as deadDelivery, but claimed first so firstAttemptAt (and lastAttemptAt) are set on the row before it
// dies - without a real attempt on it, a test can't tell a redrive that clears the field from one that never
// had it to begin with
async function deadDeliveryWithAttempt(subject: string): Promise<DeliveryRecord> {
  const created = await actionsStore.create(newDelivery({ subject }), new Date(1_000))
  if (!created) throw new Error('delivery already existed')
  const claimed = await actionsStore.claim(created, 1_500, 30_000)
  return actionsStore.markDead(claimed, 2_000, 'the destination answered 500', 500)
}

describe('deliveries through the API, over rows the actions store wrote', () => {
  it('a dead delivery appears in listDead', async () => {
    const delivery = await deadDelivery(keys.matchSubject('0x01'))
    const result = await handleListDeliveries(
      deps(),
      apiEvent({ routeKey: 'GET /v1/deliveries', queryStringParameters: { status: 'dead' } }),
    )
    const body = result.body as { deliveries: { deliveryId: string }[] }
    expect(body.deliveries.map((d) => d.deliveryId)).toContain(delivery.deliveryId)
  })

  it('requeueDelivery takes a delivery out of the dead index and into the due index, in the shard the actions store would choose', async () => {
    const delivery = await deadDelivery(keys.matchSubject('0x02'))
    const ref = refOf(delivery)
    const row = await apiStore.getDelivery(ref)
    expect(row?.status).toBe('dead')

    expect(await apiStore.requeueDelivery(row!, 4_000)).toBe(true)

    const { Item } = await dynamo.doc.send(new GetCommand({ TableName: table, Key: { PK: ref.subject, SK: ref.sk } }))
    expect(Item?.status).toBe('pending')
    expect(Item?.attempts).toBe(0)
    expect(Item?.GSI1PK).toBeUndefined()
    expect(Item?.GSI1SK).toBeUndefined()
    // the exact key services/actions/src/keys.ts's dispatcher would have written for a fresh pending delivery
    expect(Item?.GSI2PK).toBe(keys.dueDeliveries(keys.dueShard(delivery.deliveryId)))
    expect(Item?.GSI2PK).toMatch(/^DELIVERY#DUE#[0-3]$/)
    expect(Item?.GSI2SK).toBe(4_000)
  })

  it('refuses a second requeueDelivery once the delivery is no longer dead', async () => {
    const delivery = await deadDelivery(keys.matchSubject('0x03'))
    const ref = refOf(delivery)
    const row = await apiStore.getDelivery(ref)
    expect(await apiStore.requeueDelivery(row!, 5_000)).toBe(true)
    // the same row object as before: the condition the second call fails on is read from the table at the
    // moment of the update, not from whatever this test happens to be holding
    expect(await apiStore.requeueDelivery(row!, 6_000)).toBe(false)
  })

  it('enqueues a message the actions sender can parse and uses it to find the same row', async () => {
    const delivery = await deadDelivery(keys.matchSubject('0x04'))
    const ref = refOf(delivery)

    const redriveResult = await handleRedrive(
      deps(),
      apiEvent({
        routeKey: 'POST /v1/deliveries/{deliveryId}/redrive',
        pathParameters: { deliveryId: delivery.deliveryId },
        body: JSON.stringify({ ref: encodeCursor(ref) }),
      }),
    )
    expect(redriveResult.status).toBe(200)

    const { Messages } = await moto.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 10 }),
    )
    const message = Messages?.[0]
    expect(message?.Body).toBeDefined()

    // the sender's own parser (services/actions/src/sender.ts's processMessages), run on the exact body the
    // API put on the queue - no sender is registered here, so a body that parses and finds the row runs all
    // the way to "no sender for channel" and marks it dead again with that error; a body the parser cannot
    // read is instead logged and dropped, and the row is left untouched at pending
    const senderDeps: SenderPipelineDeps = {
      secrets: {
        read: async () => {
          throw new Error('not used by this test')
        },
      },
      now: () => 7_000,
      log: () => {},
      store: actionsStore,
      queue: { send: async () => {} },
      deadLetters: { send: async () => {} },
      senders: {},
    }
    const response = await processMessages(
      senderDeps,
      [{ messageId: 'redrive-1', body: message!.Body! } as SQSRecord],
      () => 999_999,
    )
    expect(response.batchItemFailures).toEqual([])

    const after = await actionsStore.get(ref)
    expect(after?.status).toBe('dead')
    expect(after?.lastError).toContain('no sender for channel')
  })

  it('getDelivery on a ref for a row that does not exist returns undefined, not a throw', async () => {
    const subject = keys.matchSubject('0x-does-not-exist')
    const ref = { subject, sk: keys.delivery(subject, 'a_00000000000000', 'match.final', 0).SK }
    await expect(apiStore.getDelivery(ref)).resolves.toBeUndefined()
  })

  it('clears firstAttemptAt (and lastError, lastStatusCode) on redrive, matching services/actions store.reset()', async () => {
    const delivery = await deadDeliveryWithAttempt(keys.matchSubject('0x05'))
    const ref = refOf(delivery)
    const before = await dynamo.doc.send(new GetCommand({ TableName: table, Key: { PK: ref.subject, SK: ref.sk } }))
    expect(before.Item?.firstAttemptAt).toBe(1_500)
    expect(before.Item?.lastAttemptAt).toBe(1_500)
    expect(before.Item?.lastError).toBe('the destination answered 500')

    const row = await apiStore.getDelivery(ref)
    expect(await apiStore.requeueDelivery(row!, 6_000)).toBe(true)

    const after = await dynamo.doc.send(new GetCommand({ TableName: table, Key: { PK: ref.subject, SK: ref.sk } }))
    // a redrive is a new life: the stale first attempt would make latency measured against it wrong for ever
    expect(after.Item?.firstAttemptAt).toBeUndefined()
    expect(after.Item?.lastError).toBeUndefined()
    expect(after.Item?.lastStatusCode).toBeUndefined()
    // reset() clears exactly those three fields and no others - lastAttemptAt is not one of them
    expect(after.Item?.lastAttemptAt).toBe(1_500)
  })

  it('listBySubject pages a subject with more deliveries than the limit, hands back a cursor rather than truncating silently', async () => {
    const subject = keys.matchSubject('0x-paged')
    const rows: DeliveryRecord[] = []
    for (let i = 0; i < 3; i++) {
      const created = await actionsStore.create(newDelivery({ subject, actionId: `action-${i}` }), new Date(1_000))
      if (!created) throw new Error('delivery already existed')
      rows.push(created)
    }

    const first = await apiStore.listBySubject(subject, 2)
    expect(first.deliveries).toHaveLength(2)
    expect(first.cursor).toBeDefined()

    const second = await apiStore.listBySubject(subject, 2, first.cursor)
    expect(second.deliveries).toHaveLength(1)
    expect(second.cursor).toBeUndefined()

    const seenIds = [...first.deliveries, ...second.deliveries].map((d) => d.deliveryId).sort()
    expect(seenIds).toEqual(rows.map((r) => r.deliveryId).sort())
  })
})

describe('store resilience to a dead row it cannot fully read', () => {
  it('skips a dead-indexed row with no channel, and does not fail the rest of the page', async () => {
    const subject = keys.matchSubject('0x-malformed')
    const badId = deliveryId(subject, 'DELIVERY#a_bad#match.final#0')
    // shaped like a real dead item (item() in services/actions/src/store.ts), minus the one field this test
    // knocks out - Terraform and a hand edit are both ways a row like this reaches production
    await dynamo.doc.send(
      new PutCommand({
        TableName: table,
        Item: {
          PK: subject,
          SK: 'DELIVERY#a_bad#match.final#0',
          deliveryId: badId,
          subject,
          status: 'dead',
          attempts: 8,
          createdAt: '2026-09-21T00:00:00.000Z',
          updatedAt: '2026-09-21T00:00:00.000Z',
          version: 1,
          GSI1PK: 'DELIVERY#DEAD',
          GSI1SK: `2026-09-21T00:00:00.000Z#${badId}`,
        },
      }),
    )
    const good = await deadDelivery(keys.matchSubject('0x-good-neighbour'))

    const page = await apiStore.listDead(100)
    const ids = page.deliveries.map((d) => d.deliveryId)
    expect(ids).not.toContain(badId)
    expect(ids).toContain(good.deliveryId)

    await expect(apiStore.getDelivery({ subject, sk: 'DELIVERY#a_bad#match.final#0' })).resolves.toBeUndefined()
  })
})

describe("targetString: what a listing shows for each channel's target, and what it must never show", () => {
  const subject = keys.matchSubject('0x-targets')
  // a secretParameter is an SSM parameter path, not the secret itself, but it is still the credential's
  // address - nothing that reduces a target for a listing may ever repeat it back, on any channel
  const secretParameterValue = '/blockwarden/secrets/do-not-leak-this-parameter'
  const headerValue = 'do-not-leak-this-header-value'

  async function putDeliveryWithTarget(sk: string, channel: string, target: Record<string, unknown>) {
    await dynamo.doc.send(
      new PutCommand({
        TableName: table,
        Item: {
          PK: subject,
          SK: sk,
          deliveryId: deliveryId(subject, sk),
          subject,
          channel,
          target,
          status: 'pending',
          attempts: 0,
          createdAt: '2026-09-21T00:00:00.000Z',
          updatedAt: '2026-09-21T00:00:00.000Z',
          version: 1,
        },
      }),
    )
  }

  it('reduces every channel to the one string that identifies it, and keeps the secret and the header out', async () => {
    await putDeliveryWithTarget('DELIVERY#a1#match.final#0', 'webhook', {
      url: 'https://hooks.example.com/services/T0/B0/secretpart',
      secretParameter: secretParameterValue,
      signatureHeader: 'X-Blockwarden-Signature',
      headers: { 'X-Extra-Header': headerValue },
    })
    await putDeliveryWithTarget('DELIVERY#a2#match.final#0', 'email', {
      to: ['ops@example.com', 'oncall@example.com'],
      secretParameter: secretParameterValue,
      headers: { 'X-Extra-Header': headerValue },
    })
    await putDeliveryWithTarget('DELIVERY#a3#match.final#0', 'telegram', { chatId: '-1001234567890' })
    await putDeliveryWithTarget('DELIVERY#a4#match.final#0', 'relay', {
      to: '0x0000000000000000000000000000000000dEaD',
    })
    await putDeliveryWithTarget('DELIVERY#a5#match.final#0', 'sqs', {
      queueArn: 'arn:aws:sqs:us-east-1:111111111111:deliveries',
    })
    await putDeliveryWithTarget('DELIVERY#a6#match.final#0', 'lambda', {
      functionArn: 'arn:aws:lambda:us-east-1:111111111111:function:deliveries',
    })
    // a channel this build does not recognise - the reducer has never heard of 'carrier-pigeon'
    await putDeliveryWithTarget('DELIVERY#a7#match.final#0', 'carrier-pigeon', {
      anything: 'goes-here',
      secretParameter: secretParameterValue,
    })

    const page = await apiStore.listBySubject(subject, 100)
    expect(page.deliveries).toHaveLength(7)
    const byChannel = new Map(page.deliveries.map((d) => [d.channel, d]))

    // webhook is unredacted at the store layer - deliveries.ts's toRow is what redacts it for the response
    expect(byChannel.get('webhook')?.target).toBe('https://hooks.example.com/services/T0/B0/secretpart')
    expect(byChannel.get('email')?.target).toBe('ops@example.com, oncall@example.com')
    expect(byChannel.get('telegram')?.target).toBe('-1001234567890')
    expect(byChannel.get('relay')?.target).toBe('0x0000000000000000000000000000000000dEaD')
    expect(byChannel.get('sqs')?.target).toBe('arn:aws:sqs:us-east-1:111111111111:deliveries')
    expect(byChannel.get('lambda')?.target).toBe('arn:aws:lambda:us-east-1:111111111111:function:deliveries')
    expect(byChannel.get('carrier-pigeon')?.target).toBe('carrier-pigeon')

    const serialized = JSON.stringify(page.deliveries)
    expect(serialized).not.toContain(secretParameterValue)
    expect(serialized).not.toContain(headerValue)
    expect(serialized).not.toContain('secretParameter')
    expect(serialized).not.toContain('headers')
  })
})
