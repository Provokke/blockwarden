import type { SQSBatchResponse, SQSRecord } from 'aws-lambda'
import { nextDelaySeconds } from './backoff.js'
import { CLAIM_LEASE_MS, MAX_ATTEMPTS } from './dispatcher.js'
import { keys } from './keys.js'
import type { DeliveryQueue } from './queue.js'
import { TERMINAL, truncate, type DeliveryChannel, type DeliveryRecord, type DeliveryRef, type Log } from './records.js'
import { DeliveryConflictError, type DeliveryStore } from './store.js'
import type { Sender, SenderDeps } from './senders/types.js'

export type Outcome = 'delivered' | 'retrying' | 'dead' | 'skipped'

export type SenderPipelineDeps = SenderDeps & {
  store: DeliveryStore
  queue: DeliveryQueue
  deadLetters: DeliveryQueue
  senders: Partial<Record<DeliveryChannel, Sender>>
  random?: () => number
  log: Log
}

export function refOf(delivery: DeliveryRecord): DeliveryRef {
  return {
    subject: delivery.subject,
    sk: keys.delivery(delivery.subject, delivery.actionId, delivery.event, delivery.seq).SK,
  }
}

export async function processDelivery(deps: SenderPipelineDeps, ref: DeliveryRef): Promise<Outcome> {
  const delivery = await deps.store.get(ref)
  // the message outlived its delivery, or another sender finished it first
  if (!delivery || TERMINAL.has(delivery.status)) return 'skipped'

  let claimed: DeliveryRecord
  try {
    claimed = await deps.store.claim(delivery, deps.now(), CLAIM_LEASE_MS)
  } catch (err) {
    if (err instanceof DeliveryConflictError) {
      deps.log('another sender has this delivery', { deliveryId: delivery.deliveryId })
      return 'skipped'
    }
    throw err
  }

  const send = deps.senders[claimed.channel]
  if (!send) {
    // a channel this build does not know is never going to work; retrying it for an hour helps nobody
    await deps.store.markDead(claimed, deps.now(), `no sender for channel ${claimed.channel}`)
    await deps.deadLetters.send(ref, 0)
    deps.log('no sender for channel', { deliveryId: claimed.deliveryId, channel: claimed.channel }, 'error')
    return 'dead'
  }

  let outcome
  try {
    outcome = await send(deps, claimed)
  } catch (err) {
    // a sender is supposed to return an outcome; one that throws is a bug, and the delivery is worth another go
    deps.log('sender threw', { deliveryId: claimed.deliveryId, error: truncate((err as Error).message) }, 'error')
    outcome = { kind: 'retry' as const, error: truncate(`the sender failed: ${(err as Error).message}`) }
  }

  if (outcome.kind === 'delivered') {
    await deps.store.markDelivered(claimed, deps.now(), outcome.statusCode)
    deps.log('delivered', { deliveryId: claimed.deliveryId, channel: claimed.channel, attempts: claimed.attempts })
    return 'delivered'
  }

  const exhausted = claimed.attempts >= MAX_ATTEMPTS
  if (outcome.kind === 'permanent' || exhausted) {
    await deps.store.markDead(claimed, deps.now(), outcome.error, outcome.statusCode)
    // the queue's depth is a free CloudWatch metric, which is what the dead-letter alarm watches
    await deps.deadLetters.send(ref, 0)
    deps.log(
      'delivery dead',
      {
        deliveryId: claimed.deliveryId,
        channel: claimed.channel,
        attempts: claimed.attempts,
        error: outcome.error,
        permanent: outcome.kind === 'permanent',
      },
      'error',
    )
    return 'dead'
  }

  const delaySeconds = nextDelaySeconds(claimed.attempts, outcome.afterSeconds, deps.random)
  await deps.store.scheduleRetry(
    claimed,
    deps.now(),
    deps.now() + delaySeconds * 1000,
    outcome.error,
    outcome.statusCode,
  )
  await deps.queue.send(ref, delaySeconds)
  deps.log(
    'delivery failed; another attempt is scheduled',
    {
      deliveryId: claimed.deliveryId,
      channel: claimed.channel,
      attempts: claimed.attempts,
      delaySeconds,
      error: outcome.error,
    },
    'warn',
  )
  return 'retrying'
}

export async function processMessages(deps: SenderPipelineDeps, records: SQSRecord[]): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = []
  for (const record of records) {
    let ref: DeliveryRef
    try {
      const parsed = JSON.parse(record.body) as DeliveryRef
      if (typeof parsed?.subject !== 'string' || typeof parsed?.sk !== 'string') throw new Error('not a delivery ref')
      ref = parsed
    } catch (err) {
      // nothing will ever parse this; reporting it would only send it round the queue five more times
      deps.log(
        'message is not a delivery reference',
        { messageId: record.messageId, error: (err as Error).message },
        'error',
      )
      continue
    }
    try {
      await processDelivery(deps, ref)
    } catch (err) {
      // DynamoDB or SQS; every other failure has already been turned into an outcome
      deps.log(
        'delivery could not be processed',
        { messageId: record.messageId, error: truncate((err as Error).message) },
        'error',
      )
      batchItemFailures.push({ itemIdentifier: record.messageId })
    }
  }
  return { batchItemFailures }
}
