import {
  checkDestinationUrl,
  DEFAULT_DELIVERY_HEADER,
  DEFAULT_SIGNATURE_HEADER,
  headerName,
  parameterName,
} from '@blockwarden/core'
import type { SQSBatchResponse } from 'aws-lambda'
import { z } from 'zod'
import { actionId, canonicalJson, deliveryId } from './ids.js'
import { keys } from './keys.js'
import type { DeliveryQueue } from './queue.js'
import { MAX_PAYLOAD_BYTES, truncate, type Log, type NewDelivery } from './records.js'
import type { DeliveryStore } from './store.js'

export const outboundRequestSchema = z
  .strictObject({
    // the caller's own idempotency key: the same id is the same delivery for ever
    requestId: z.string().min(1).max(200),
    url: z.string().superRefine((raw, ctx) => {
      const checked = checkDestinationUrl(raw)
      if (!checked.ok) ctx.addIssue({ code: 'custom', message: checked.reason })
    }),
    // the same name rule a rule's own webhook action uses; this is the field that picks the secret bytes
    secretParameter: parameterName,
    signatureHeader: headerName.optional(),
    deliveryHeader: headerName.optional(),
    // this becomes a header value: anything outside printable ASCII makes Node throw on the write, which the
    // sender reads as worth retrying, and a delivery that can never succeed burns every attempt it has
    eventId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x20-\x7e]+$/, 'expected printable ASCII')
      .optional(),
    // an object is serialised; a string is signed exactly as it arrived
    body: z.union([z.string(), z.looseObject({})]),
  })
  // the same rule a webhook action's schema enforces: one name for both headers means one of them wins and, if
  // it is the signature that loses, the request goes out unsigned
  .refine(
    (request) =>
      (request.signatureHeader ?? DEFAULT_SIGNATURE_HEADER).toLowerCase() !==
      (request.deliveryHeader ?? DEFAULT_DELIVERY_HEADER).toLowerCase(),
    'expected the signature and delivery headers to be different headers, not the same header twice',
  )

export type OutboundRequest = z.infer<typeof outboundRequestSchema>

// the fields that decide where the bytes go and which secret signs them
type Destination = { url: string; secretParameter?: string; signatureHeader?: string; deliveryHeader?: string }

// two requests mean the same destination when the sender would do the same thing with them: the same URL as it
// would send it, the same parameter, and the same header names, which are case-insensitive and have defaults
function destinationOf(d: Destination): string {
  const url = new URL(d.url)
  return canonicalJson({
    // rebuilt from the parts, so an empty query or fragment and a default port drop out
    url: `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`,
    secretParameter: d.secretParameter,
    signatureHeader: (d.signatureHeader ?? DEFAULT_SIGNATURE_HEADER).toLowerCase(),
    deliveryHeader: (d.deliveryHeader ?? DEFAULT_DELIVERY_HEADER).toLowerCase(),
  })
}

export type OutboundDeps = {
  // only what accepting a request needs; the fakes stay compile-time bound to the real store
  store: Pick<DeliveryStore, 'create' | 'get' | 'markQueued'>
  queue: DeliveryQueue
  now: () => Date
  log: Log
  // Terraform's list; the sender's IAM policy grants the same paths
  allowedSecretPrefixes: readonly string[]
}

export async function acceptOutbound(
  deps: OutboundDeps,
  messages: { messageId: string; body: string }[],
): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = []
  for (const message of messages) {
    const refuse = (reason: string) => {
      // the reason names the field, never the body or the secret's value, and it is built from what the caller
      // sent, so it is capped like every other error string here rather than letting a caller size the log line
      deps.log('outbound request refused', { messageId: message.messageId, reason: truncate(reason) }, 'error')
      batchItemFailures.push({ itemIdentifier: message.messageId })
    }
    let parsed: OutboundRequest
    try {
      parsed = outboundRequestSchema.parse(JSON.parse(message.body))
    } catch (err) {
      refuse(
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : 'the message is not JSON',
      )
      continue
    }
    // a prefix names a level of the hierarchy, not a run of characters: /billwarden must not admit
    // /billwardenX, which is somebody else's parameter, so the comparison is made against the level separator
    const under = (prefix: string) => parsed.secretParameter.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
    if (!deps.allowedSecretPrefixes.some(under)) {
      refuse(`secretParameter is not under an allowed prefix`)
      continue
    }
    const payload = typeof parsed.body === 'string' ? parsed.body : JSON.stringify(parsed.body)
    if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
      refuse(`body is larger than ${MAX_PAYLOAD_BYTES} bytes`)
      continue
    }

    const subject = keys.outboundSubject(parsed.requestId)
    // the request id alone is the key: the same id is the same delivery, for ever. Folding the destination in
    // would make a re-pointed id a second delivery, and the caller's idempotency key would stop being one.
    const id = actionId({ type: 'outbound', requestId: parsed.requestId })
    const { SK } = keys.delivery(subject, id, 'outbound', 0)
    const delivery: NewDelivery = {
      deliveryId: deliveryId(subject, SK),
      subject,
      actionId: id,
      event: 'outbound',
      seq: 0,
      channel: 'webhook',
      target: {
        channel: 'webhook',
        url: parsed.url,
        secretParameter: parsed.secretParameter,
        ...(parsed.signatureHeader ? { signatureHeader: parsed.signatureHeader } : {}),
        ...(parsed.deliveryHeader ? { deliveryHeader: parsed.deliveryHeader } : {}),
        ...(parsed.eventId ? { eventId: parsed.eventId } : {}),
      },
      payload,
    }

    try {
      const created = await deps.store.create(delivery, deps.now())
      if (!created) {
        // the id is taken. If it was taken by this same destination the request is an ordinary repeat; if it
        // was taken by another one the caller has reused an idempotency key, which no retry can fix, so it is
        // refused rather than delivered twice or quietly sent somewhere else.
        const existing = await deps.store.get({ subject, sk: SK })
        if (
          existing &&
          existing.target.channel === 'webhook' &&
          destinationOf(existing.target) !== destinationOf(parsed)
        ) {
          refuse('requestId was already accepted for another destination')
          continue
        }
        deps.log('outbound request already accepted', { requestId: parsed.requestId })
        continue
      }
      await deps.queue.send({ subject, sk: SK }, 0)
      await deps.store.markQueued(created, deps.now().getTime())
    } catch (err) {
      // DynamoDB or SQS; the message goes back on the queue and is tried again
      deps.log(
        'outbound request could not be stored',
        { messageId: message.messageId, error: (err as Error).message },
        'error',
      )
      batchItemFailures.push({ itemIdentifier: message.messageId })
    }
  }
  return { batchItemFailures }
}
