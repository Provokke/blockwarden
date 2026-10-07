import { CreateEmailIdentityCommand } from '@aws-sdk/client-sesv2'
import { CreateQueueCommand, DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { verifyWebhook } from '@blockwarden/relayer-client'
import type { SQSRecord } from 'aws-lambda'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dispatchRecords, sweepDue } from '../../src/dispatcher.js'
import { keys } from '../../src/keys.js'
import { createLookup } from '../../src/lookup.js'
import { sqsDeliveryQueue } from '../../src/queue.js'
import { DEADLINE_MARGIN_MS, processMessages } from '../../src/sender.js'
import { sendEmail } from '../../src/senders/email.js'
import { sendWebhook } from '../../src/senders/webhook.js'
import { DeliveryStore } from '../../src/store.js'
import { matchRow, txRow } from '../helpers/images.js'
import { startReceiver } from '../helpers/receiver.js'
import { startDynamo, startMoto } from '../helpers/store.js'
import { streamReader } from '../helpers/stream.js'

// Two things this file cannot prove against DynamoDB Local, on real infrastructure elsewhere in the pipeline:
// - it suppresses a MODIFY for a write that changes nothing, which real DynamoDB does not promise. The
//   dispatcher's idempotence is proved by the conditional put (dispatcher.test.ts), not by anything here.
// - it never expires a TTL item, so no TTL REMOVE record is ever produced here. The dispatcher ignores every
//   REMOVE regardless of cause, and a unit test in events.test.ts covers that directly.

const webhookSk = (d: { subject: string; actionId: string; event: string; seq: number }) =>
  keys.delivery(d.subject, d.actionId, d.event, d.seq).SK

let dynamo: Awaited<ReturnType<typeof startDynamo>>
let moto: Awaited<ReturnType<typeof startMoto>>
let receiver: Awaited<ReturnType<typeof startReceiver>>
let stream: Awaited<ReturnType<typeof streamReader>>
let store: DeliveryStore
let tableName: string
let queueUrl: string
let dlqUrl: string

const SECRET = 'e2e-secret'

beforeAll(async () => {
  ;[dynamo, moto, receiver] = await Promise.all([startDynamo(), startMoto(), startReceiver()])
  tableName = await dynamo.newTable()
  store = new DeliveryStore(dynamo.doc, tableName)
  stream = await streamReader(dynamo.client, dynamo.endpoint, tableName)
  queueUrl = (await moto.sqs.send(new CreateQueueCommand({ QueueName: 'deliveries' }))).QueueUrl!
  dlqUrl = (await moto.sqs.send(new CreateQueueCommand({ QueueName: 'deliveries-dlq' }))).QueueUrl!
  await moto.ses.send(new CreateEmailIdentityCommand({ EmailIdentity: 'alerts@example.com' }))

  await dynamo.doc.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: 'RULE#rule-1',
        SK: 'META',
        ruleId: 'rule-1',
        active: true,
        input: {
          chainId: 8453,
          addresses: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
          event: 'event Transfer(address indexed from, address indexed to, uint256 value)',
          confirmation: { mode: 'fast' },
          actions: [
            { type: 'webhook', url: `https://example.com/hook` },
            { type: 'email', to: ['ops@example.com'] },
          ],
        },
        createdAt: 'x',
        updatedAt: 'x',
      },
    }),
  )
  await dynamo.doc.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: 'SIGNER#demo',
        SK: 'META',
        signerId: 'demo',
        keyId: 'k',
        chainIds: [84532],
        webhooks: ['https://example.com/tx'],
        webhookSecretParameter: '/bw/secret',
      },
    }),
  )
}, 300_000)

afterAll(async () => {
  stream.destroy()
  await Promise.all([dynamo.stop(), moto.stop(), receiver.stop()])
})

const queue = () => sqsDeliveryQueue(moto.sqs, queueUrl)
const deadLetters = () => sqsDeliveryQueue(moto.sqs, dlqUrl)

const dispatcherDeps = () => ({
  store,
  lookup: createLookup(dynamo.doc, tableName, { ttlMs: 0 }),
  queue: queue(),
  // the reaper's dead-letter path shares this queue with the sender's, and sweepDue's deps require it now
  deadLetters: deadLetters(),
  now: () => new Date(),
  log: () => {},
})

// the senders reach the local receiver the way the guard would have: the destination is resolved for them,
// because 127.0.0.1 is refused by the guard on purpose
const senderDeps = () => ({
  store,
  queue: queue(),
  deadLetters: deadLetters(),
  senders: { webhook: sendWebhook, email: sendEmail },
  secrets: { read: async () => [SECRET] },
  now: () => Date.now(),
  log: () => {},
  // rule-1's webhook action names no secretParameter of its own, the way an operator-configured default would
  // stand in for it in production; secrets.read above ignores the name and answers with SECRET regardless
  defaultWebhookSecretParameter: '/bw/secret',
  resolve: async () => ({
    url: new URL(receiver.url),
    host: '127.0.0.1',
    address: '127.0.0.1',
    family: 4 as const,
    port: receiver.port,
  }),
  ses: moto.ses,
  fromAddress: 'alerts@example.com',
  random: () => 0.5,
})

async function drain(): Promise<number> {
  let handled = 0
  for (;;) {
    const { Messages = [] } = await moto.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
    )
    if (Messages.length === 0) return handled
    const records = Messages.map((m) => ({ messageId: m.MessageId!, body: m.Body! }) as SQSRecord)
    const { batchItemFailures } = await processMessages(senderDeps() as never, records, () => DEADLINE_MARGIN_MS)
    expect(batchItemFailures).toEqual([])
    for (const message of Messages) {
      handled++
      await moto.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }))
    }
  }
}

async function pump(): Promise<void> {
  const records = await stream.read()
  const { batchItemFailures } = await dispatchRecords(dispatcherDeps() as never, records)
  expect(batchItemFailures).toEqual([])
}

describe('a match, end to end', () => {
  it('reaches a webhook that verifies and an inbox', async () => {
    receiver.answerWith(204)
    const row = matchRow({ status: 'provisional', PK: 'MATCH#0xe2e1', matchKey: '0xe2e1' })
    await dynamo.doc.send(new PutCommand({ TableName: tableName, Item: row }))
    await pump()
    expect(await drain()).toBe(2)

    const delivered = receiver.received.at(-1)!
    const event = await verifyWebhook({
      payload: delivered.body,
      signature: delivered.headers['x-blockwarden-signature'] as string,
      secret: SECRET,
    })
    expect(event.type).toBe('match.provisional')
    expect(event.id).toBe(delivered.headers['x-blockwarden-delivery'])
    expect((event.data as { eventName: string }).eventName).toBe('Transfer')

    const email = (await moto.sentEmails()).at(-1)!
    expect(email.destinations.ToAddresses).toEqual(['ops@example.com'])
    expect(email.subject).toContain('Transfer on chain 8453')
  })

  it('sends a second delivery when the match becomes final', async () => {
    const before = receiver.received.length
    await dynamo.doc.send(
      new PutCommand({
        TableName: tableName,
        Item: matchRow({
          status: 'final',
          PK: 'MATCH#0xe2e1',
          matchKey: '0xe2e1',
          finalizedAt: '2026-09-20T10:19:00.000Z',
        }),
      }),
    )
    await pump()
    await drain()
    expect(receiver.received.length).toBeGreaterThan(before)
    const event = JSON.parse(receiver.received.at(-1)!.body)
    expect(event.type).toBe('match.final')
  })
})

describe('a transaction, end to end', () => {
  it('sends one delivery per status change, and two tx.mined after a reorg', async () => {
    const history = [{ status: 'queued', at: 't0' }]
    await dynamo.doc.send(
      new PutCommand({ TableName: tableName, Item: txRow({ PK: 'TX#e2e', txId: 'e2e', signerId: 'demo', history }) }),
    )
    await pump()
    await drain()

    const mined = [...history, { status: 'submitted', at: 't1' }, { status: 'mined', at: 't2' }]
    await dynamo.doc.send(
      new PutCommand({
        TableName: tableName,
        Item: txRow({
          PK: 'TX#e2e',
          txId: 'e2e',
          signerId: 'demo',
          status: 'mined',
          history: mined,
          mined: { hash: '0xaa', blockNumber: 7, blockHash: '0xbb', status: 'success' },
        }),
      }),
    )
    await pump()
    await drain()

    // a reorg took the receipt away and a rebroadcast mined it again
    const remined = [...mined, { status: 'submitted', at: 't3' }, { status: 'mined', at: 't4' }]
    await dynamo.doc.send(
      new PutCommand({
        TableName: tableName,
        Item: txRow({
          PK: 'TX#e2e',
          txId: 'e2e',
          signerId: 'demo',
          status: 'mined',
          history: remined,
          mined: { hash: '0xcc', blockNumber: 9, blockHash: '0xdd', status: 'success' },
        }),
      }),
    )
    await pump()
    await drain()

    const minedEvents = receiver.received.filter((r) => JSON.parse(r.body).type === 'tx.mined')
    expect(minedEvents).toHaveLength(2)
    // the second mined is a delivery of its own, so a receiver that dedupes on the header still sees both
    expect(new Set(minedEvents.map((r) => r.headers['x-blockwarden-delivery'])).size).toBe(2)
    expect(JSON.parse(minedEvents[1]!.body).data.blockNumber).toBe(9)
  })
})

describe('failure, dead letters and a redrive', () => {
  it('retries, dies, lands on the dead-letter queue and goes again after a redrive', async () => {
    receiver.answerWith(503)
    const row = matchRow({ status: 'final', PK: 'MATCH#0xe2e2', matchKey: '0xe2e2' })
    await dynamo.doc.send(new PutCommand({ TableName: tableName, Item: row }))
    await pump()
    await drain()

    const due = await store.listDue(Date.now() + 10 ** 9, 50)
    const failed = due.find((d) => d.subject === 'MATCH#0xe2e2' && d.channel === 'webhook')!
    expect(failed.status).toBe('failed')
    expect(failed.attempts).toBe(1)
    expect(failed.lastStatusCode).toBe(503)

    // the reaper is what carries it on here, rather than waiting out seven real backoffs
    for (let attempt = 2; attempt <= 8; attempt++) {
      const current = (await store.listDue(Date.now() + 10 ** 9, 50)).find((d) => d.deliveryId === failed.deliveryId)
      if (!current) break
      await store.scheduleRetry(current, Date.now(), Date.now() - 120_000, 'forced due')
      await sweepDue(dispatcherDeps() as never, Date.now(), 50)
      await drain()
    }

    const dead = await store.listDead(50)
    expect(dead.map((d) => d.deliveryId)).toContain(failed.deliveryId)
    const { Messages } = await moto.sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 10 }))
    expect((Messages ?? []).map((m) => JSON.parse(m.Body!).subject)).toContain('MATCH#0xe2e2')

    receiver.answerWith(204)
    const revived = await store.reset(
      dead.find((d) => d.deliveryId === failed.deliveryId)!,
      Date.now(),
    )
    await queue().send({ subject: revived.subject, sk: webhookSk(revived) }, 0)
    await drain()
    expect((await store.get({ subject: revived.subject, sk: webhookSk(revived) }))!.status).toBe('delivered')
    expect(await store.listDead(50)).toHaveLength(0)
  })
})
