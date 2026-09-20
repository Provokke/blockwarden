import type { ActionInput } from '@blockwarden/core'
import type { DynamoDBBatchResponse, DynamoDBRecord } from 'aws-lambda'
import { changesFor, type Change } from './events.js'
import { actionId, deliveryId } from './ids.js'
import { DeliverySeqRangeError, keys, refOf } from './keys.js'
import type { Lookup } from './lookup.js'
import type { DeliveryQueue } from './queue.js'
import { matchEventData, renderEvent, txEventData } from './render.js'
import {
  PayloadTooLargeError,
  type DeliveryChannel,
  type DeliveryRecord,
  type DeliveryTarget,
  type Log,
  type NewDelivery,
} from './records.js'
import { readRecord } from './stream.js'
import { REAPER_GRACE_MS, type DeliveryStore, type DueCursor } from './store.js'

export const MAX_ATTEMPTS = 8
// how long a claim holds a delivery before the reaper treats the sender as gone; twice the sender's own timeout
export const CLAIM_LEASE_MS = 120_000
// one sweep reads at most this many pages, so a scheduled run always ends
export const MAX_SWEEP_PAGES = 10
// the grace the reaper waits past a due time lives with the store, which queues deliveries out by the same one
export { REAPER_GRACE_MS }

// only the store methods the dispatcher uses. The real DeliveryStore still satisfies it, and a test fake is
// then a plain object rather than a cast that hides every way the fake has drifted from the store.
export type DispatcherStore = Pick<DeliveryStore, 'create' | 'markQueued' | 'markDead' | 'listDuePage'>

export type DispatcherDeps = {
  store: DispatcherStore
  lookup: Lookup
  queue: DeliveryQueue
  // the reaper kills a delivery too, and dead has to mean the same thing whichever path got there
  deadLetters: DeliveryQueue
  now: () => Date
  log: Log
}

function targetFor(action: ActionInput): DeliveryTarget {
  switch (action.type) {
    case 'webhook':
      return {
        channel: 'webhook',
        url: action.url,
        ...pick(action, 'secretParameter', 'signatureHeader', 'deliveryHeader'),
      }
    case 'email':
      return { channel: 'email', to: action.to, ...pick(action, 'subject') }
    case 'telegram':
      return { channel: 'telegram', chatId: action.chatId }
    case 'relay':
      return {
        channel: 'relay',
        signerId: action.signerId,
        chainId: action.chainId,
        to: action.to,
        data: action.data,
        ...pick(action, 'value', 'gasLimit'),
      }
    case 'sqs':
      return { channel: 'sqs', queueArn: action.queueArn }
    case 'lambda':
      return { channel: 'lambda', functionArn: action.functionArn }
  }
}

function pick<T extends object, K extends keyof T>(source: T, ...names: K[]): Partial<Pick<T, K>> {
  return Object.fromEntries(names.filter((n) => source[n] !== undefined).map((n) => [n, source[n]])) as Partial<
    Pick<T, K>
  >
}

async function plan(deps: DispatcherDeps, change: Change): Promise<NewDelivery[]> {
  if (change.kind === 'match') {
    const rule = await deps.lookup.rule(change.ruleId)
    if (!rule) {
      deps.log('no rule for match', { matchKey: change.matchKey, ruleId: change.ruleId }, 'warn')
      return []
    }
    // a provisional alert and its drop notice belong to a fast rule; a finalized rule hears only the final record
    if (change.event !== 'match.final' && rule.mode !== 'fast') return []
    const data = matchEventData(change.row, rule)
    return rule.actions.map((entry) => {
      const { SK } = keys.delivery(change.subject, entry.actionId, change.event, change.seq)
      const id = deliveryId(change.subject, SK)
      return {
        deliveryId: id,
        subject: change.subject,
        actionId: entry.actionId,
        event: change.event,
        seq: change.seq,
        channel: entry.action.type as DeliveryChannel,
        target: targetFor(entry.action),
        payload: renderEvent({ deliveryId: id, type: change.event, createdAt: change.at, data }),
      }
    })
  }

  const signerId = typeof change.row.signerId === 'string' ? change.row.signerId : ''
  const signer = await deps.lookup.signer(signerId)
  if (!signer) {
    deps.log('no signer for transaction', { txId: change.txId, signerId }, 'warn')
    return []
  }
  const data = txEventData(change.row)
  return signer.webhooks.map((url) => {
    const action: ActionInput = {
      type: 'webhook',
      url,
      ...(signer.webhookSecretParameter ? { secretParameter: signer.webhookSecretParameter } : {}),
    }
    const id = actionId(action)
    const { SK } = keys.delivery(change.subject, id, change.event, change.seq)
    const delivery = deliveryId(change.subject, SK)
    return {
      deliveryId: delivery,
      subject: change.subject,
      actionId: id,
      event: change.event,
      seq: change.seq,
      channel: 'webhook' as const,
      target: targetFor(action),
      payload: renderEvent({ deliveryId: delivery, type: change.event, createdAt: change.at, data }),
    }
  })
}

// A throw that is a property of the record itself: the same bytes and the same sequence number come back on
// every delivery of it, so reporting it back would stall every later record on this ordered shard for the
// stream's whole 24-hour retention. Everything else - DynamoDB, SQS - might pass next time and is reported.
function poison(err: unknown): string | undefined {
  if (err instanceof DeliverySeqRangeError) return `sequence number ${err.seq} is past the width of the sort key`
  if (err instanceof PayloadTooLargeError) return `payload of ${err.bytes} bytes is over the size cap`
  return undefined
}

export async function dispatchRecords(deps: DispatcherDeps, records: DynamoDBRecord[]): Promise<DynamoDBBatchResponse> {
  for (const record of records) {
    const change = readRecord(record)
    if (!change) continue
    try {
      for (const item of changesFor(change)) {
        for (const delivery of await plan(deps, item)) {
          const created = await deps.store.create(delivery, deps.now())
          // already created by an earlier delivery of this record; its message was sent then, and the reaper
          // covers the case where it was not
          if (!created) continue
          await deps.queue.send(refOf(created), 0)
          await deps.store.markQueued(created, deps.now().getTime())
        }
      }
    } catch (err) {
      const reason = poison(err)
      if (reason) {
        // Logged and skipped, never retried. Nothing was written for it - create() refuses the oversized
        // payload before it puts anything, and the range error happens before there is a sort key to write
        // under at all - so there is no item here to mark dead; the log line is the record of it.
        deps.log(
          'record skipped; nothing about it can succeed',
          {
            reason,
            sequenceNumber: record.dynamodb?.SequenceNumber,
            pk: change.pk,
            sk: change.sk,
            error: (err as Error).message,
          },
          'error',
        )
        continue
      }
      // Lambda checkpoints at the lowest sequence number returned and retries from there, so reporting this one
      // and stopping is the same as reporting the rest too
      deps.log(
        'dispatch failed; the stream will deliver this record again',
        { sequenceNumber: record.dynamodb?.SequenceNumber, error: (err as Error).message },
        'error',
      )
      const itemIdentifier = record.dynamodb?.SequenceNumber
      // Lambda rejects a partial-batch response holding an empty identifier and retries the whole batch; a
      // record with no sequence number cannot be named, so say that outright rather than send a shape it refuses
      if (!itemIdentifier) throw err
      return { batchItemFailures: [{ itemIdentifier }] }
    }
  }
  return { batchItemFailures: [] }
}

export async function sweepDue(
  deps: DispatcherDeps,
  nowMs: number,
  limit: number,
): Promise<{ requeued: number; dead: number }> {
  let requeued = 0
  let dead = 0
  let cursor: DueCursor | undefined
  // page through the backlog: a delivery the sweep keeps failing on must not hide everything behind it
  for (let page = 0; page < MAX_SWEEP_PAGES; page++) {
    const due = await deps.store.listDuePage(nowMs - REAPER_GRACE_MS, limit, cursor)
    for (const delivery of due.deliveries) {
      try {
        if (delivery.attempts >= MAX_ATTEMPTS) {
          // Send the copy before marking the delivery dead - the other way round from the sender's own path.
          // markDead drops the delivery from the due index, and once that commits nothing brings the delivery
          // back if the copy then fails to land. Sending first means a failed copy leaves the delivery due and
          // otherwise untouched, so the next sweep tries both steps again; a duplicate copy that does land costs
          // nothing (the alarm only watches the dead-letter queue's depth), but a missing one costs the alarm.
          await deps.deadLetters.send(refOf(delivery), 0)
          await deps.store.markDead(delivery, nowMs, 'every attempt was used and no sender finished it')
          dead++
          continue
        }
        const queued = await deps.store.markQueued(delivery, nowMs)
        await deps.queue.send(refOf(queued), 0)
        requeued++
      } catch (err) {
        // one delivery's conflict is another sender working on it; a dead-letter copy that hasn't landed yet
        // leaves the delivery due and unchanged either way, so the sweep just moves on and tries again next time
        deps.log(
          'could not process a due delivery',
          { deliveryId: delivery.deliveryId, error: (err as Error).message },
          'warn',
        )
      }
    }
    cursor = due.cursor
    if (!cursor) break
  }
  return { requeued, dead }
}
