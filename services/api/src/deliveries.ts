import { redactedUrl } from '@blockwarden/core'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { decodeCursor, encodeCursor, error, ok, readJsonBody, type ApiResult } from './http.js'
import type { DeliveryItem, DeliveryRef, DeliveryStore } from './store.js'

const MAX_PAGE = 100
const SUBJECT_KINDS = ['MATCH#', 'TX#', 'OUTBOUND#']

// GSI1's own LastEvaluatedKey for the dead-letter query is always exactly these four string attributes -
// proven by reading one back from DynamoDB Local, not assumed (same reasoning as matches.ts's isMatchListKey).
// The cursor is unsigned base64, so any caller can hand back a crafted key; anything of another shape must
// never reach ExclusiveStartKey, where DynamoDB answers a bad key with a ValidationException that has no
// route-level catch.
const DEAD_LIST_KEY_ATTRS = ['PK', 'SK', 'GSI1PK', 'GSI1SK'] as const

function isDeadListKey(value: unknown): value is Record<(typeof DEAD_LIST_KEY_ATTRS)[number], string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== DEAD_LIST_KEY_ATTRS.length) return false
  return DEAD_LIST_KEY_ATTRS.every((attr) => typeof record[attr] === 'string')
}

export type DeliveryDeps = {
  store: DeliveryStore
  queue: { send(body: string): Promise<void> }
  queueUrl: string
  now(): number
}

export async function handleListDeliveries(deps: DeliveryDeps, event: APIGatewayProxyEventV2): Promise<ApiResult> {
  const query = event.queryStringParameters ?? {}
  const limit = pageSize(query.limit)

  if (query.subject) {
    if (!SUBJECT_KINDS.some((kind) => query.subject!.startsWith(kind))) {
      return error(400, 'invalid_subject', 'a subject is MATCH#…, TX#… or OUTBOUND#…')
    }
    const page = await deps.store.listBySubject(query.subject, limit)
    return ok({ deliveries: page.deliveries.map(toRow) })
  }

  if (query.status === undefined) return error(400, 'filter_required', 'status=dead or a subject is required')
  // GSI1 holds a delivery only while it is dead; every other status would need a scan of the whole table,
  // which on a growing table is the difference between a $1 month and a $40 one
  if (query.status !== 'dead') {
    return error(400, 'unsupported_status', 'only status=dead is indexed; list a subject for the rest')
  }

  let startKey: Record<string, unknown> | undefined
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor)
    if (!cursor || !isDeadListKey(cursor)) return error(400, 'invalid_cursor', 'that cursor cannot be read')
    startKey = cursor
  }
  const page = await deps.store.listDead(limit, startKey)
  return ok({
    deliveries: page.deliveries.map(toRow),
    ...(page.cursor ? { cursor: encodeCursor(page.cursor) } : {}),
  })
}

export async function handleRedrive(deps: DeliveryDeps, event: APIGatewayProxyEventV2): Promise<ApiResult> {
  const deliveryId = event.pathParameters?.deliveryId ?? ''
  const body = event.body === undefined ? { ok: true as const, value: {} } : readJsonBody(event)
  if (!body.ok) return body.result
  const rawRef = (body.value as { ref?: unknown }).ref
  if (typeof rawRef !== 'string') return error(400, 'ref_required', 'the ref from the listing is required')
  const decoded = decodeCursor(rawRef)
  if (!decoded || typeof decoded.subject !== 'string' || typeof decoded.sk !== 'string') {
    return error(400, 'invalid_ref', 'that ref cannot be read')
  }
  const ref: DeliveryRef = { subject: decoded.subject, sk: decoded.sk }

  const delivery = await deps.store.getDelivery(ref)
  if (!delivery) return error(404, 'delivery_not_found', 'no delivery is there')
  // the id in the path is the one the operator saw; a ref pointing at a different row would redrive something
  // other than what they clicked
  if (delivery.deliveryId !== deliveryId) {
    return error(400, 'ref_mismatch', 'that ref is for another delivery')
  }
  if (delivery.status !== 'dead') {
    return error(409, 'not_dead', `that delivery is ${delivery.status}, so there is nothing to redrive`)
  }

  // the row is reset first: a delivery that is pending with a due time is one the reaper owns, so an enqueue
  // that fails afterwards is swept rather than lost. The other order would leave a queued message pointing at
  // a row still marked dead, which the sender refuses
  const reset = await deps.store.requeueDelivery(delivery, deps.now())
  if (!reset) return error(409, 'not_dead', 'that delivery changed before it could be redriven')
  // the exact shape services/actions/src/sender.ts's processMessages parses off the queue: a DeliveryRef,
  // nothing more - the item itself is the truth, so the message carries only a pointer to it
  await deps.queue.send(JSON.stringify({ subject: delivery.subject, sk: delivery.sk }))
  return ok({ deliveryId, status: 'pending' })
}

function toRow(delivery: DeliveryItem) {
  return {
    deliveryId: delivery.deliveryId,
    ref: encodeCursor({ subject: delivery.subject, sk: delivery.sk }),
    subject: delivery.subject,
    channel: delivery.channel,
    // a webhook path is the credential for Slack, Discord and most hosted receivers
    target: delivery.channel === 'webhook' ? redactedUrl(delivery.target) : delivery.target,
    status: delivery.status,
    attempts: delivery.attempts,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
    ...(delivery.lastError ? { lastError: delivery.lastError } : {}),
    ...(delivery.lastStatusCode ? { lastStatusCode: delivery.lastStatusCode } : {}),
  }
}

function pageSize(raw: string | undefined): number {
  const asked = Number(raw ?? MAX_PAGE)
  if (!Number.isInteger(asked) || asked < 1) return MAX_PAGE
  return Math.min(asked, MAX_PAGE)
}
