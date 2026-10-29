import { relay as relayTx, RelayerApiError, type RelayerClientOptions } from '@blockwarden/relayer-client'
import { truncate } from '../records.js'
import type { Sender, SendOutcome } from './types.js'

// A few relayer codes mean "ask again shortly" (busy, rpc_unavailable, and the client's
// network_error and throttled). Everything else follows the status the relayer answered with: 4xx
// means the request is wrong and resending fails the same way; 5xx (or a client code like
// invalid_response) is the relayer's fault this attempt.
const TRANSIENT_CODES = new Set(['network_error', 'throttled', 'busy', 'rpc_unavailable'])

function classify(err: RelayerApiError): SendOutcome {
  // err.message can quote the request, which carried the API key, so only report the code
  const message = `the relayer answered ${err.status} ${err.code}`
  if (TRANSIENT_CODES.has(err.code)) return { kind: 'retry', error: message }
  if (err.status >= 400 && err.status < 500) return { kind: 'permanent', error: message }
  return { kind: 'retry', error: message }
}

export const sendRelay: Sender = async (deps, delivery) => {
  if (delivery.target.channel !== 'relay') throw new Error(`delivery ${delivery.deliveryId} is not a relay`)
  if (!deps.relayerApiUrl || !deps.relayerApiKeyParameter) {
    return { kind: 'permanent', error: 'no relayer API is configured for this deployment' }
  }

  let apiKey: string
  try {
    const [first] = await deps.secrets.read(deps.relayerApiKeyParameter)
    // an empty parameter is more often a half-done rotation than a decision; webhook and telegram
    // senders treat it as worth another attempt too
    if (!first) {
      return {
        kind: 'retry',
        error: truncate(`parameter ${deps.relayerApiKeyParameter} holds no relayer API key`),
      }
    }
    apiKey = first
  } catch (err) {
    return { kind: 'retry', error: truncate(`the relayer API key could not be read: ${(err as Error).message}`) }
  }

  const { signerId, chainId, to, data, value, gasLimit } = delivery.target
  const submit = deps.relay ?? relayTx
  const options: RelayerClientOptions = { baseUrl: deps.relayerApiUrl, apiKey }
  // the client only knows one bound (it aborts past it); the tighter of the two limits governs
  const bounds = [deps.timeoutMs, deps.deadlineMs].filter((n): n is number => n !== undefined)
  if (bounds.length > 0) options.timeoutMs = Math.min(...bounds)
  try {
    // relayer-client uses globalThis.fetch, not node:https (it also runs in edge runtimes). That's fine here: the URL is operator config, not a caller-supplied destination needing the SSRF guard.
    await submit(options, {
      signerId,
      chainId,
      to,
      data,
      ...(value === undefined ? {} : { value: BigInt(value) }),
      ...(gasLimit === undefined ? {} : { gasLimit: BigInt(gasLimit) }),
      // one key per delivery: a retry after a timeout gets the first transaction back, not a second
      idempotencyKey: delivery.deliveryId,
      // the caller's own string, so a downstream project can join the tx to what caused it
      reference: delivery.subject.slice(0, 128),
    })
    return { kind: 'delivered' }
  } catch (err) {
    if (!(err instanceof RelayerApiError)) {
      return { kind: 'retry', error: truncate(`the relayer could not be called: ${(err as Error).message}`) }
    }
    return classify(err)
  }
}
