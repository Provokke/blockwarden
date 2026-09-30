import type { ActionInput } from '@blockwarden/core'
import type { DynamoDBBatchResponse, DynamoDBRecord } from 'aws-lambda'
import { underAnyPrefix } from './config.js'
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
// how long a claim holds before the reaper treats the sender as gone (twice the sender's timeout)
export const CLAIM_LEASE_MS = 120_000
// one sweep reads at most this many pages so it always ends
export const MAX_SWEEP_PAGES = 10
export { REAPER_GRACE_MS }

// only the store methods the dispatcher uses, so a test fake is a plain object, not a cast
export type DispatcherStore = Pick<DeliveryStore, 'create' | 'markQueued' | 'markDead' | 'listDuePage'>

export type DispatcherDeps = {
  store: DispatcherStore
  lookup: Lookup
  queue: DeliveryQueue
  // the reaper kills deliveries too, so dead has to mean the same on both paths
  deadLetters: DeliveryQueue
  now: () => Date
  log: Log
  // Terraform's list; the sender's IAM policy grants the same paths
  ruleSecretPrefixes: readonly string[]
}

// The sender reads whatever parameter a webhook action names and signs with it. Without a list a
// rule could name another party's secret and use us as a signing oracle. Separate from the outbound
// list so granting a rule's secret doesn't widen outbound.
function namesAnAllowedSecret(deps: DispatcherDeps, action: ActionInput): boolean {
  if (action.type !== 'webhook' || action.secretParameter === undefined) return true
  return underAnyPrefix(deps.ruleSecretPrefixes, action.secretParameter)
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
    // a provisional alert and its drop notice belong to a fast rule; a finalised rule only hears
    // the final record
    if (change.event !== 'match.final' && rule.mode !== 'fast') return []
    const data = matchEventData(change.row, rule)
    return rule.actions.flatMap((entry) => {
      if (!namesAnAllowedSecret(deps, entry.action)) {
        deps.log(
          'an action names a secret parameter that is not under an allowed prefix',
          { matchKey: change.matchKey, ruleId: change.ruleId, actionId: entry.actionId },
          'error',
        )
        return []
      }
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

// A throw that's a property of the record itself comes back identical every time, so reporting it
// would stall the shard for the stream's whole retention. Anything else (DynamoDB, SQS) might pass
// next time and is reported.
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
          // already created by an earlier delivery; the reaper covers a message that never went out
          if (!created) continue
          await deps.queue.send(refOf(created), 0)
          await deps.store.markQueued(created, deps.now().getTime())
        }
      }
    } catch (err) {
      const reason = poison(err)
      if (reason) {
        // Logged and skipped, never retried. Nothing was written (oversized payloads are refused
        // before the put), so there's no item to mark dead.
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
      // Lambda retries from the lowest sequence number returned, so reporting this one and stopping
      // is the same as reporting the rest
      deps.log(
        'dispatch failed; the stream will deliver this record again',
        { sequenceNumber: record.dynamodb?.SequenceNumber, error: (err as Error).message },
        'error',
      )
      const itemIdentifier = record.dynamodb?.SequenceNumber
      // Lambda rejects an empty identifier and retries the whole batch, so say outright that this
      // record can't be named
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
  // page through the backlog so a delivery that keeps failing can't hide the rest
  for (let page = 0; page < MAX_SWEEP_PAGES; page++) {
    const due = await deps.store.listDuePage(nowMs - REAPER_GRACE_MS, limit, cursor)
    for (const delivery of due.deliveries) {
      try {
        if (delivery.attempts >= MAX_ATTEMPTS) {
          // Send the copy before marking dead, the opposite of the sender's path. markDead drops it
          // from the due index, so a failed copy afterwards would never retry. Copy first and a
          // failure leaves it due for the next sweep; a duplicate is harmless.
          await deps.deadLetters.send(refOf(delivery), 0)
          await deps.store.markDead(delivery, nowMs, 'every attempt was used and no sender finished it')
          dead++
          continue
        }
        const queued = await deps.store.markQueued(delivery, nowMs)
        await deps.queue.send(refOf(queued), 0)
        requeued++
      } catch (err) {
        // another sender is on it, or the copy hasn't landed; either way it stays due and the sweep
        // retries next time
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
