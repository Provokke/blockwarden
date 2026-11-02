import { MetricUnit, type Metrics } from '@aws-lambda-powertools/metrics'
import type { SQSBatchResponse, SQSRecord } from 'aws-lambda'
import { nextDelaySeconds } from './backoff.js'
import { DEFAULT_DEADLINE_MS } from './destination.js'
import { CLAIM_LEASE_MS, MAX_ATTEMPTS } from './dispatcher.js'
import { refOf } from './keys.js'
import type { DeliveryQueue } from './queue.js'
import { TERMINAL, truncate, type DeliveryChannel, type DeliveryRecord, type DeliveryRef, type Log } from './records.js'
import { DeliveryConflictError, type DeliveryStore } from './store.js'
import type { ProductionSenderDeps, Sender, SendOutcome, SenderDeps } from './senders/types.js'

export type Outcome = 'delivered' | 'retrying' | 'dead' | 'skipped'

// The DynamoDB and SQS round trips around one attempt (get, claim, record write, queue send), plus
// slack for one throttled write.
const ATTEMPT_AWS_MS = 5_000

// Stop taking messages once less than one whole attempt remains. A send runs to its own deadline,
// and a timeout throws away the partial-batch response, so already-sent messages would come back.
export const DEADLINE_MARGIN_MS = DEFAULT_DEADLINE_MS + ATTEMPT_AWS_MS

// only the store methods the pipeline uses, like the dispatcher, so fake drift is a compile error
export type SenderStore = Pick<DeliveryStore, 'get' | 'claim' | 'markDelivered' | 'scheduleRetry' | 'markDead'>

// fields every pipeline wiring adds on top of a plain sender's deps, kept once so the production
// and test shapes can't drift
type PipelineExtras = {
  store: SenderStore
  queue: DeliveryQueue
  deadLetters: DeliveryQueue
  senders: Partial<Record<DeliveryChannel, Sender>>
  random?: () => number
  log: Log
  // delivery-failure metric. Optional so hand-built test deps still compile; production always
  // supplies it.
  metrics?: Metrics
}

export type SenderPipelineDeps = SenderDeps & PipelineExtras

// what the Lambda entry point builds: `SenderDeps` minus the two local-server hatches, so real
// wiring can't set `resolve` or `post` and bypass the guard
export type ProductionSenderPipelineDeps = ProductionSenderDeps & PipelineExtras

// The one delivery-failure metric. Shares the reaper's name so there's no new billed custom metric;
// CloudWatch merges points with the same namespace, name and dimensions. No per-channel dimension,
// six channels would be six billed metrics.
function countDead(deps: Pick<SenderPipelineDeps, 'metrics'>): void {
  deps.metrics?.singleMetric().addMetric('deliveriesDead', MetricUnit.Count, 1)
}

export async function processDelivery(deps: SenderPipelineDeps, ref: DeliveryRef): Promise<Outcome> {
  const delivery = await deps.store.get(ref)
  // the message outlived its delivery
  if (!delivery) return 'skipped'
  // another sender finished it first, or this one did and only the copy failed
  if (TERMINAL.has(delivery.status)) {
    // markDead lands before the copy, so a transient SQS error leaves a dead delivery the alarm
    // can't see; the redelivery copies it. Nothing consumes the dead-letter queue (only its depth
    // is watched), so a duplicate is free.
    if (delivery.status === 'dead') {
      await deps.deadLetters.send(ref, 0)
      // the first pass may have died before logging, so this line is the only trace; the failure
      // metric has to count this branch as dead too
      deps.log('re-sent a dead-letter copy for a delivery already marked dead', { deliveryId: delivery.deliveryId })
      countDead(deps)
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
    // a channel this build doesn't know will never work, so don't retry it for an hour
    await deps.store.markDead(claimed, deps.now(), `no sender for channel ${claimed.channel}`)
    await deps.deadLetters.send(ref, 0)
    deps.log('no sender for channel', { deliveryId: claimed.deliveryId, channel: claimed.channel }, 'error')
    countDead(deps)
    return 'dead'
  }

  let outcome
  try {
    outcome = await send(deps, claimed)
  } catch (err) {
    // a sender should return an outcome; one that throws is a bug, worth another go
    deps.log('sender threw', { deliveryId: claimed.deliveryId, error: truncate((err as Error).message) }, 'error')
    outcome = { kind: 'retry' as const, error: truncate(`the sender failed: ${(err as Error).message}`) }
  }

  try {
    return await recordOutcome(deps, ref, claimed, outcome)
  } catch (err) {
    // The send already happened. A conflict means the lease moved on (reaper requeued, another
    // invocation claimed it), so that one owns the outcome. Reporting an infra failure would send
    // the same body twice.
    if (err instanceof DeliveryConflictError) {
      deps.log('another invocation owns this delivery now', { deliveryId: claimed.deliveryId }, 'warn')
      return 'skipped'
    }
    throw err
  }
}

// write the attempt's ending down and enqueue what follows
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
    // queue depth is a free CloudWatch metric, which the dead-letter alarm watches
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
    countDead(deps)
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
  // remaining Lambda time; required so forgetting it fails to compile instead of running with no
  // margin
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
      // nothing will ever parse this; reporting it would just send it round the queue again
      deps.log(
        'message is not a delivery reference',
        { messageId: record.messageId, error: (err as Error).message },
        'error',
      )
      continue
    }
    // checked after the parse: an unparseable body is poison however much time is left
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
      // DynamoDB or SQS; every other failure has already become an outcome
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
