import type { SQSBatchResponse, SQSRecord } from 'aws-lambda'
import { nextDelaySeconds } from './backoff.js'
import { DEFAULT_DEADLINE_MS } from './destination.js'
import { CLAIM_LEASE_MS, MAX_ATTEMPTS } from './dispatcher.js'
import { refOf } from './keys.js'
import type { DeliveryQueue } from './queue.js'
import { TERMINAL, truncate, type DeliveryChannel, type DeliveryRecord, type DeliveryRef, type Log } from './records.js'
import { DeliveryConflictError, type DeliveryStore } from './store.js'
import type { Sender, SendOutcome, SenderDeps } from './senders/types.js'

export type Outcome = 'delivered' | 'retrying' | 'dead' | 'skipped'

// The DynamoDB and SQS round trips around one attempt: the get, the claim, the record write and the queue send,
// with enough slack for one throttled write the SDK retries.
const ATTEMPT_AWS_MS = 5_000

// Stop taking messages once less than one whole attempt's time remains. A send runs to its own absolute deadline
// before it gives up, so a batch started with less than that left times out mid-attempt, and Lambda throws the
// partial-batch response away: every message in it comes back, including the ones whose sends already happened.
export const DEADLINE_MARGIN_MS = DEFAULT_DEADLINE_MS + ATTEMPT_AWS_MS

// only the store methods the pipeline uses, as the dispatcher does it: the real DeliveryStore still satisfies
// it, and a test fake is a plain object whose drift from the store is a compile error rather than a silence
export type SenderStore = Pick<DeliveryStore, 'get' | 'claim' | 'markDelivered' | 'scheduleRetry' | 'markDead'>

export type SenderPipelineDeps = SenderDeps & {
  store: SenderStore
  queue: DeliveryQueue
  deadLetters: DeliveryQueue
  senders: Partial<Record<DeliveryChannel, Sender>>
  random?: () => number
  log: Log
}

// the reaper names a delivery to the dead-letter queue the same way, so the two share one builder
export { refOf }

export async function processDelivery(deps: SenderPipelineDeps, ref: DeliveryRef): Promise<Outcome> {
  const delivery = await deps.store.get(ref)
  // the message outlived its delivery
  if (!delivery) return 'skipped'
  // another sender finished it first, or this one did and only the copy failed
  if (TERMINAL.has(delivery.status)) {
    // markDead lands before the copy does, so a transient SQS error leaves a dead delivery the alarm cannot see;
    // the redelivery arrives here and copies it. Nothing consumes the dead-letter queue - it is watched for its
    // depth - so a second pointer for a copy that did land costs nothing, and a missing one costs the alarm.
    if (delivery.status === 'dead') {
      await deps.deadLetters.send(ref, 0)
      // the first pass may have died before it logged anything (that's the whole reason this copy is needed),
      // so this line is the only trace of it; Task 14's metrics need to count this branch as dead too, not only
      // the pass that called markDead
      deps.log('re-sent a dead-letter copy for a delivery already marked dead', { deliveryId: delivery.deliveryId })
    }
    return 'skipped'
  }

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

  try {
    return await recordOutcome(deps, ref, claimed, outcome)
  } catch (err) {
    // The send already happened. A conflict here means the lease moved on - the reaper requeued this delivery and
    // another invocation claimed it - so that invocation owns the outcome now. Reporting an infrastructure
    // failure instead would run claim and send again and the receiver would see the same body twice.
    if (err instanceof DeliveryConflictError) {
      deps.log('another invocation owns this delivery now', { deliveryId: claimed.deliveryId }, 'warn')
      return 'skipped'
    }
    throw err
  }
}

// write the attempt's ending down and enqueue whatever follows from it
async function recordOutcome(
  deps: SenderPipelineDeps,
  ref: DeliveryRef,
  claimed: DeliveryRecord,
  outcome: SendOutcome,
): Promise<Outcome> {
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

export async function processMessages(
  deps: SenderPipelineDeps,
  records: SQSRecord[],
  // remaining time on the Lambda invocation; required so a caller that forgets it fails to compile rather than
  // silently running with no deadline margin at all
  remainingMs: () => number,
): Promise<SQSBatchResponse> {
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
    // checked after the parse: an unparseable body is poison however much time is left, and handing it back
    // would only send it round the queue again
    if (remainingMs() < DEADLINE_MARGIN_MS) {
      deps.log('message not attempted; too little time remains before the Lambda timeout', {
        messageId: record.messageId,
      })
      batchItemFailures.push({ itemIdentifier: record.messageId })
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
