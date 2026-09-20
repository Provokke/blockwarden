import { checkDestinationUrl, DEFAULT_DELIVERY_HEADER, DEFAULT_SIGNATURE_HEADER, headerName } from '@blockwarden/core'
import type { SQSBatchResponse } from 'aws-lambda'
import { z } from 'zod'
import { actionId, deliveryId } from './ids.js'
import { keys } from './keys.js'
import type { DeliveryQueue } from './queue.js'
import { MAX_PAYLOAD_BYTES, type Log, type NewDelivery } from './records.js'
import type { DeliveryStore } from './store.js'

export const outboundRequestSchema = z
  .strictObject({
    // the caller's own idempotency key: the same id is the same delivery for ever
    requestId: z.string().min(1).max(200),
    url: z.string().superRefine((raw, ctx) => {
      const checked = checkDestinationUrl(raw)
      if (!checked.ok) ctx.addIssue({ code: 'custom', message: checked.reason })
    }),
    secretParameter: z.string().startsWith('/').max(1011),
    signatureHeader: headerName.optional(),
    deliveryHeader: headerName.optional(),
    eventId: z.string().min(1).max(200).optional(),
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

export type OutboundDeps = {
  store: DeliveryStore
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
      // the reason names the field, never the body or the secret's value
      deps.log('outbound request refused', { messageId: message.messageId, reason }, 'error')
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
    if (!deps.allowedSecretPrefixes.some((prefix) => parsed.secretParameter.startsWith(prefix))) {
      refuse(`secretParameter is not under an allowed prefix`)
      continue
    }
    const payload = typeof parsed.body === 'string' ? parsed.body : JSON.stringify(parsed.body)
    if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
      refuse(`body is larger than ${MAX_PAYLOAD_BYTES} bytes`)
      continue
    }

    const subject = keys.outboundSubject(parsed.requestId)
    // the id covers the destination, so re-pointing a request id at another URL is a different delivery rather
    // than a silent no-op
    const id = actionId({
      type: 'webhook',
      url: parsed.url,
      secretParameter: parsed.secretParameter,
      signatureHeader: parsed.signatureHeader,
      deliveryHeader: parsed.deliveryHeader,
    })
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
