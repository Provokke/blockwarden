import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs'
import { redactedUrl } from '@blockwarden/core'
import type { DeliveryRecord, DeliveryRef } from '../src/records.js'
import type { DeadCursor, DeliveryStore } from '../src/store.js'

// re-exported so this script and the api service's delivery routes share one definition
export { redactedUrl }

export function describeTarget(delivery: Pick<DeliveryRecord, 'channel' | 'target'>): string {
  return delivery.target.channel === 'webhook' ? redactedUrl(delivery.target.url) : delivery.channel
}

// a count an operator typed: undefined means "say so and stop", not hand "abc" to the AWS SDK and
// print its stack
export function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined
}

type RedriveArgs = { table?: string | undefined; queue?: string | undefined; id?: string | undefined; all?: boolean }

// One receive only returns what's visible now, and a message we're not responsible for comes back
// after its visibility timeout. So stop at the first empty receive, not an empty queue.
const RECEIVES_MAX = 200
const DRAIN_VISIBILITY_SECONDS = 30

// The dead-letter copy is what holds the alarm in ALARM, and resetting the delivery item doesn't
// touch it. Leave it and the alarm stays latched until someone purges the queue or 14 days pass.
// A delivery can have several copies on purpose (the sender copies an already-dead delivery every
// time, the reaper copies before markDead). So keep draining to the first empty receive and delete
// every copy we recognise.
export async function drainRedriven(
  sqs: Pick<SQSClient, 'send'>,
  queueUrl: string,
  redriven: DeliveryRef[],
): Promise<number> {
  // both sides are refOf()'s object serialised the same way, which makes the comparison exact
  const wanted = new Set(redriven.map((ref) => JSON.stringify(ref)))
  let deleted = 0
  if (wanted.size === 0) return 0
  for (let receives = 0; receives < RECEIVES_MAX; receives++) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        VisibilityTimeout: DRAIN_VISIBILITY_SECONDS,
        WaitTimeSeconds: 1,
      }),
    )
    if (!Messages || Messages.length === 0) return deleted
    for (const message of Messages) {
      // only a copy of a delivery this run redrove; anything else on the queue isn't ours
      if (!message.Body || !wanted.has(message.Body) || !message.ReceiptHandle) continue
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }))
      deleted++
    }
  }
  return deleted
}

// This mutates production, so the two selectors can't both apply: "--id x --all" would redrive
// everything with the id unchecked.
export function checkRedriveArgs(values: RedriveArgs): string | undefined {
  if (!values.table) return 'pass --table <name> or set TABLE_NAME'
  if (!values.queue) return 'pass --queue <url> or set DELIVERY_QUEUE_URL'
  if (values.id && values.all) return 'pass either --id <deliveryId> or --all, not both'
  if (!values.id && !values.all) return 'pass --id <deliveryId> or --all'
  return undefined
}

// The dead list is the only index (no lookup by id alone). One page isn't the list, so past a page
// --all is silently partial and --id reports a real delivery as missing, mid-incident.
export async function allDead(store: Pick<DeliveryStore, 'listDeadPage'>, pageSize = 200): Promise<DeliveryRecord[]> {
  const found: DeliveryRecord[] = []
  let cursor: DeadCursor | undefined
  do {
    const page = await store.listDeadPage(pageSize, cursor)
    found.push(...page.deliveries)
    cursor = page.cursor
  } while (cursor)
  return found
}
