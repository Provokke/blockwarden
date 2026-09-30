import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs'
import { redactedUrl } from '@blockwarden/core'
import type { DeliveryRecord, DeliveryRef } from '../src/records.js'
import type { DeadCursor, DeliveryStore } from '../src/store.js'

// re-exported so the two callers (this script and the api service's delivery routes) share one definition
export { redactedUrl }

export function describeTarget(delivery: Pick<DeliveryRecord, 'channel' | 'target'>): string {
  return delivery.target.channel === 'webhook' ? redactedUrl(delivery.target.url) : delivery.channel
}

// a count an operator typed: undefined means "say so and stop", rather than handing "abc" to the AWS SDK and
// printing its stack trace
export function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined
}

type RedriveArgs = { table?: string | undefined; queue?: string | undefined; id?: string | undefined; all?: boolean }

// One receive only ever returns what is visible now, and a message this redrive is not responsible for comes
// back after its visibility timeout. So the loop stops at the first empty receive rather than at an empty queue.
const RECEIVES_MAX = 200
const DRAIN_VISIBILITY_SECONDS = 30

// The dead-letter copy is what holds the dead-letters alarm in ALARM: it is a separate message, and resetting
// the delivery item does not touch it. A redrive that left it there would fix the delivery and leave the alarm
// latched until an operator purged the queue or the fourteen days ran out.
//
// One delivery can have several copies on the queue, deliberately: the sender copies a delivery that is already
// dead every time the queue hands it back, and the reaper copies before markDead so a lost copy leaves the
// delivery due. So the drain keeps going to the first empty receive and deletes every copy it recognises,
// rather than stopping once it has seen one of each.
export async function drainRedriven(
  sqs: Pick<SQSClient, 'send'>,
  queueUrl: string,
  redriven: DeliveryRef[],
): Promise<number> {
  // both sides of this comparison are refOf()'s object serialised the same way, which is what makes it exact
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
      // only a copy of a delivery this run redrove; anything else on the queue is someone else's to answer for
      if (!message.Body || !wanted.has(message.Body) || !message.ReceiptHandle) continue
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }))
      deleted++
    }
  }
  return deleted
}

// This command mutates production state, so the two selectors cannot both be honoured: "--id x --all" would
// redrive everything while the named id went unchecked.
export function checkRedriveArgs(values: RedriveArgs): string | undefined {
  if (!values.table) return 'pass --table <name> or set TABLE_NAME'
  if (!values.queue) return 'pass --queue <url> or set DELIVERY_QUEUE_URL'
  if (values.id && values.all) return 'pass either --id <deliveryId> or --all, not both'
  if (!values.id && !values.all) return 'pass --id <deliveryId> or --all'
  return undefined
}

// The dead list is the only index there is: there is no lookup by delivery id alone. One page of it is not the
// list, so past a page --all is silently partial and --id reports a delivery that exists as missing - during
// exactly the incident this tool is for.
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
