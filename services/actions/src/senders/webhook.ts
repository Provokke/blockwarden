import { DELIVERY_HEADER, SIGNATURE_HEADER, signWebhook } from '@blockwarden/relayer-client'
import { DestinationError, postJson, resolveDestination } from '../destination.js'
import { truncate } from '../records.js'
import type { Sender, SendOutcome } from './types.js'

// one timestamp, one v1 per secret: verifyWebhook accepts any of them, which is what makes a rotation overlap
export async function signatureFor(payload: string, secrets: string[], nowMs: number): Promise<string> {
  if (secrets.length === 0) throw new Error('a webhook cannot be signed without a secret')
  const headers = await Promise.all(secrets.map((secret) => signWebhook({ payload, secret, nowMs })))
  const [first] = headers
  return [first, ...headers.slice(1).map((h) => h.slice(h.indexOf('v1=')))].join(',')
}

export const sendWebhook: Sender = async (deps, delivery) => {
  if (delivery.target.channel !== 'webhook') throw new Error(`delivery ${delivery.deliveryId} is not a webhook`)
  const { url, secretParameter, signatureHeader, deliveryHeader } = delivery.target
  // an empty name is no name, and falling through to the default beats dead-lettering the delivery
  const parameter = secretParameter || deps.defaultWebhookSecretParameter
  if (!parameter) {
    deps.log('a webhook action names no secret parameter', { deliveryId: delivery.deliveryId }, 'warn')
    return { kind: 'permanent', error: 'no webhook secret is configured for this action' }
  }

  const signatureName = signatureHeader ?? SIGNATURE_HEADER
  const deliveryName = deliveryHeader ?? DELIVERY_HEADER
  // the rule schema refuses this pair, but a rule stored before it did can still reach here, and one object
  // literal would let the delivery id land on the signature's key and ship the request unsigned
  if (signatureName.toLowerCase() === deliveryName.toLowerCase()) {
    deps.log(
      'a webhook action names the signature and delivery headers the same header',
      { deliveryId: delivery.deliveryId, actionId: delivery.actionId, header: deliveryName },
      'warn',
    )
    return {
      kind: 'permanent',
      error: truncate(`${signatureName} and ${deliveryName} are the same header, so the delivery was not sent`),
    }
  }

  let secrets: string[]
  try {
    secrets = await deps.secrets.read(parameter)
  } catch (err) {
    // a throttled or briefly unavailable parameter is not the receiver's fault
    return { kind: 'retry', error: truncate(`the webhook secret could not be read: ${(err as Error).message}`) }
  }

  let headers: Record<string, string>
  try {
    headers = {
      [signatureName]: await signatureFor(delivery.payload, secrets, deps.now()),
      [deliveryName]: delivery.target.eventId ?? delivery.deliveryId,
    }
  } catch (err) {
    // an empty or unusable secret is a fault in the configuration, not a destination that would not answer
    deps.log('a webhook delivery could not be signed', { deliveryId: delivery.deliveryId }, 'warn')
    return { kind: 'permanent', error: truncate(`the delivery could not be signed: ${(err as Error).message}`) }
  }
  // the names were compared above; this is the proof that both of them survived the object literal
  if (Object.keys(headers).length !== 2) {
    return { kind: 'permanent', error: 'the signature header was displaced, so the delivery was not sent' }
  }

  const resolve = deps.resolve ?? ((raw: string) => resolveDestination(raw, deps.resolver))
  const post = deps.post ?? postJson
  try {
    const target = await resolve(url)
    const answer = await post(target, delivery.payload, headers, {
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      ...(deps.deadlineMs === undefined ? {} : { deadlineMs: deps.deadlineMs }),
    })
    return classify(answer.statusCode, answer.body, answer.retryAfterSeconds)
  } catch (err) {
    if (err instanceof DestinationError) {
      return err.retryable
        ? { kind: 'retry', error: truncate(err.message) }
        : { kind: 'permanent', error: truncate(err.message) }
    }
    return { kind: 'retry', error: truncate(`the destination could not be reached: ${(err as Error).message}`) }
  }
}

function classify(statusCode: number, body: string, retryAfterSeconds?: number): SendOutcome {
  if (statusCode >= 200 && statusCode < 300) return { kind: 'delivered', statusCode }
  if (statusCode >= 300 && statusCode < 400) {
    // the URL has to be the final one; following it is how an SSRF guard is walked around
    return { kind: 'permanent', error: `the destination answered with a redirect, which is not followed`, statusCode }
  }
  if (statusCode === 429 || statusCode >= 500) {
    return {
      kind: 'retry',
      error: truncate(`the destination answered ${statusCode}: ${body}`),
      statusCode,
      ...(retryAfterSeconds === undefined ? {} : { afterSeconds: retryAfterSeconds }),
    }
  }
  return { kind: 'permanent', error: truncate(`the destination answered ${statusCode}: ${body}`), statusCode }
}
