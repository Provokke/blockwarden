import { setTimeout as sleep } from 'node:timers/promises'
import { CreateEmailIdentityCommand } from '@aws-sdk/client-sesv2'
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { verifyWebhook } from '@blockwarden/relayer-client'
import type { DynamoDBRecord, SQSRecord } from 'aws-lambda'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allDead, drainRedriven } from '../../scripts/lib.js'
import { DestinationError, type Resolved } from '../../src/destination.js'
import { dispatchRecords, sweepDue, type DispatcherDeps } from '../../src/dispatcher.js'
import { refOf } from '../../src/keys.js'
import { createLookup } from '../../src/lookup.js'
import { sqsDeliveryQueue } from '../../src/queue.js'
import { DEADLINE_MARGIN_MS, processMessages, type SenderPipelineDeps } from '../../src/sender.js'
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
//
// The tests below run in order and build on each other: the second writes over the row the first created, and
// each one counts what the receiver was sent since the one before it.

let dynamo: Awaited<ReturnType<typeof startDynamo>>
let moto: Awaited<ReturnType<typeof startMoto>>
let receiver: Awaited<ReturnType<typeof startReceiver>>
let stream: Awaited<ReturnType<typeof streamReader>>
let store: DeliveryStore
let tableName: string
let queueUrl: string
let dlqUrl: string

// The rule's webhook and the signer's own are separate destinations with separate secrets, so a delivery that
// went to the wrong one, or was signed with the other one's secret, fails here rather than passing unnoticed.
const RULE_URL = 'https://example.com/hook'
const SIGNER_URL = 'https://example.com/tx'
const RULE_PARAMETER = '/bw/rule-secret'
const SIGNER_PARAMETER = '/bw/signer-secret'
const SECRETS: Record<string, string> = {
  [RULE_PARAMETER]: 'e2e-rule-secret',
  [SIGNER_PARAMETER]: 'e2e-signer-secret',
}
const PATHS: Record<string, string> = { [RULE_URL]: '/hook', [SIGNER_URL]: '/tx' }

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
            { type: 'webhook', url: RULE_URL },
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
        webhooks: [SIGNER_URL],
        webhookSecretParameter: SIGNER_PARAMETER,
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

const dispatcherDeps = (): DispatcherDeps => ({
  store,
  lookup: createLookup(dynamo.doc, tableName, { ttlMs: 0 }),
  queue: queue(),
  // the reaper's dead-letter path shares this queue with the sender's, and sweepDue's deps require it now
  deadLetters: deadLetters(),
  now: () => new Date(),
  log: () => {},
})

// The senders reach the local receiver the way the guard would have: the destination is resolved for them,
// because 127.0.0.1 is refused by the guard on purpose. It is resolved from the URL the delivery really names
// though, and each destination has its own path here, so a delivery aimed anywhere else is refused.
const resolve = async (raw: string): Promise<Resolved> => {
  const path = PATHS[raw]
  if (!path) throw new DestinationError(`the destination is refused: nothing in this test serves ${raw}`)
  return {
    url: new URL(receiver.urlFor(path)),
    host: '127.0.0.1',
    address: '127.0.0.1',
    family: 4,
    port: receiver.port,
  }
}

const senderDeps = (): SenderPipelineDeps => ({
  store,
  queue: queue(),
  deadLetters: deadLetters(),
  senders: { webhook: sendWebhook, email: sendEmail },
  // a reader that answered the same secret to every name would hide a delivery signed with the wrong one
  secrets: {
    read: async (name: string) => {
      const secret = SECRETS[name]
      if (!secret) throw new Error(`no parameter named ${name}`)
      return [secret]
    },
  },
  now: () => Date.now(),
  log: () => {},
  // rule-1's webhook action names no secretParameter of its own, the way an operator-configured default would
  // stand in for it in production; the signer's webhook names its own and must not be signed with this one
  defaultWebhookSecretParameter: RULE_PARAMETER,
  resolve,
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
    const { batchItemFailures } = await processMessages(senderDeps(), records, () => DEADLINE_MARGIN_MS)
    expect(batchItemFailures).toEqual([])
    for (const message of Messages) {
      handled++
      await moto.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }))
    }
  }
}

// The write is acknowledged before its record is on the stream, so an empty first read is a slow machine rather
// than an empty stream, and dispatching nothing would quietly prove nothing. This returns on the first read that
// has records, so a healthy run waits for none of it.
async function readStream(): Promise<DynamoDBRecord[]> {
  for (let wait = 10; wait <= 320; wait *= 2) {
    const records = await stream.read()
    if (records.length > 0) return records
    await sleep(wait)
  }
  return stream.read()
}

async function pump(): Promise<void> {
  const records = await readStream()
  const { batchItemFailures } = await dispatchRecords(dispatcherDeps(), records)
  expect(batchItemFailures).toEqual([])
}

// what the receiver was sent since a mark, as event types; sorted, because SQS promises no order within a batch
const typesSince = (mark: number) =>
  receiver.received
    .slice(mark)
    .map((r) => JSON.parse(r.body).type as string)
    .sort()

describe('a match, end to end', () => {
  it('reaches a webhook that verifies and an inbox', async () => {
    receiver.answerWith(204)
    const before = receiver.received.length
    const row = matchRow({ status: 'provisional', PK: 'MATCH#0xe2e1', matchKey: '0xe2e1' })
    await dynamo.doc.send(new PutCommand({ TableName: tableName, Item: row }))
    await pump()
    expect(await drain()).toBe(2)
    // one delivery per action, the webhook and the email, and neither of them twice
    expect(receiver.received.length).toBe(before + 1)

    const delivered = receiver.received.at(-1)!
    // the rule's own URL, not the signer's and not whatever the guard was handed
    expect(delivered.path).toBe('/hook')
    const event = await verifyWebhook({
      payload: delivered.body,
      signature: delivered.headers['x-blockwarden-signature'] as string,
      secret: SECRETS[RULE_PARAMETER]!,
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
    // the same two actions again, one delivery each, exactly one of which reaches the webhook
    expect(await drain()).toBe(2)
    expect(receiver.received.length).toBe(before + 1)
    const delivered = receiver.received.at(-1)!
    expect(delivered.path).toBe('/hook')
    expect(JSON.parse(delivered.body).type).toBe('match.final')
  })
})

describe('a transaction, end to end', () => {
  it('sends one delivery per status change, and two tx.mined after a reorg', async () => {
    const start = receiver.received.length
    const history = [{ status: 'queued', at: 't0' }]
    await dynamo.doc.send(
      new PutCommand({ TableName: tableName, Item: txRow({ PK: 'TX#e2e', txId: 'e2e', signerId: 'demo', history }) }),
    )
    await pump()
    // the signer has one webhook, so every status change is one delivery and no status change is silent
    let mark = receiver.received.length
    expect(await drain()).toBe(1)
    expect(typesSince(mark)).toEqual(['tx.queued'])

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
    // two entries arrived on one write, and each of them is a delivery of its own
    mark = receiver.received.length
    expect(await drain()).toBe(2)
    expect(typesSince(mark)).toEqual(['tx.mined', 'tx.submitted'])

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
    mark = receiver.received.length
    expect(await drain()).toBe(2)
    expect(typesSince(mark)).toEqual(['tx.mined', 'tx.submitted'])

    const sent = receiver.received.slice(start)
    // five status changes, five deliveries, every one of them at the signer's own URL
    expect(sent).toHaveLength(5)
    expect(new Set(sent.map((r) => r.path))).toEqual(new Set(['/tx']))
    // signed with the signer's own secret, not the default the rule's webhook falls back to
    const signed = await verifyWebhook({
      payload: sent[0]!.body,
      signature: sent[0]!.headers['x-blockwarden-signature'] as string,
      secret: SECRETS[SIGNER_PARAMETER]!,
    })
    expect(signed.type).toBe('tx.queued')

    const minedEvents = sent.filter((r) => JSON.parse(r.body).type === 'tx.mined')
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
      await sweepDue(dispatcherDeps(), Date.now(), 50)
      await drain()
    }

    const dead = await store.listDead(50)
    expect(dead.map((d) => d.deliveryId)).toContain(failed.deliveryId)
    // read the copy without hiding it, because the redrive below has to find it on the queue
    const { Messages } = await moto.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 10, VisibilityTimeout: 0 }),
    )
    expect((Messages ?? []).map((m) => JSON.parse(m.Body!).subject)).toContain('MATCH#0xe2e2')

    receiver.answerWith(204)
    // The redrive script's own steps, in its order, through its own functions. scripts/redrive.ts is a top-level
    // module that reads process.argv, builds its AWS clients from the environment and calls process.exit, so
    // importing it from here would run it; everything it does past the argument parsing is allDead, store.reset,
    // refOf, queue.send and drainRedriven, and those all run below against the real table and the real queues.
    const chosen = (await allDead(store)).find((d) => d.deliveryId === failed.deliveryId)!
    const revived = await store.reset(chosen, Date.now())
    const ref = refOf(revived)
    await queue().send(ref, 0)
    // the delivery is on its way again; this is what takes its copy off the queue so the depth alarm can clear
    expect(await drainRedriven(moto.sqs, dlqUrl, [ref])).toBe(1)
    await drain()
    expect((await store.get(ref))!.status).toBe('delivered')
    expect(await store.listDead(50)).toHaveLength(0)
    // the depth the alarm watches, not a receive: a copy that was only made invisible would read as an empty queue
    const { Attributes } = await moto.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    )
    expect(Attributes?.ApproximateNumberOfMessages).toBe('0')
    expect(Attributes?.ApproximateNumberOfMessagesNotVisible).toBe('0')
  })
})
