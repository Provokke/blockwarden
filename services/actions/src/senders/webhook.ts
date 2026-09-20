import { signWebhook } from '@blockwarden/relayer-client'
import { DestinationError, postJson, resolveDestination } from '../destination.js'
import { truncate } from '../records.js'
import type { Sender, SendOutcome } from './types.js'

const DEFAULT_SIGNATURE_HEADER = 'X-Blockwarden-Signature'
const DEFAULT_DELIVERY_HEADER = 'X-Blockwarden-Delivery'

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
  const parameter = secretParameter ?? deps.defaultWebhookSecretParameter
  if (!parameter) {
    return { kind: 'permanent', error: 'no webhook secret is configured for this action' }
  }

  let secrets: string[]
  try {
    secrets = await deps.secrets.read(parameter)
  } catch (err) {
    // a throttled or briefly unavailable parameter is not the receiver's fault
    return { kind: 'retry', error: truncate(`the webhook secret could not be read: ${(err as Error).message}`) }
  }

  const resolve = deps.resolve ?? ((raw: string) => resolveDestination(raw, deps.resolver))
  const post = deps.post ?? postJson
  try {
    const target = await resolve(url)
    const answer = await post(
      target,
      delivery.payload,
      {
        [signatureHeader ?? DEFAULT_SIGNATURE_HEADER]: await signatureFor(delivery.payload, secrets, deps.now()),
        [deliveryHeader ?? DEFAULT_DELIVERY_HEADER]: delivery.deliveryId,
      },
      {
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        ...(deps.deadlineMs === undefined ? {} : { deadlineMs: deps.deadlineMs }),
      },
    )
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
