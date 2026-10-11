import { relay as relayTx, RelayerApiError, type RelayerClientOptions } from '@blockwarden/relayer-client'
import { truncate } from '../records.js'
import type { Sender, SendOutcome } from './types.js'

// A handful of the relayer's own codes mean "ask again shortly" rather than "this request is bad" -
// services/relayer/src/api.ts (busy), src/submit.ts (rpc_unavailable), and the client's own
// packages/relayer-client/src/client.ts (network_error: no answer came back; throttled: API Gateway's own
// 429, before any relayer code exists). Everything else follows the status the relayer actually answered
// with: a 4xx means the request itself is wrong and resending it verbatim fails the same way again; a 5xx
// (or a client-side code such as invalid_response, wrapped around whatever status came with it) is the
// relayer's own fault this attempt, not the request's.
const TRANSIENT_CODES = new Set(['network_error', 'throttled', 'busy', 'rpc_unavailable'])

function classify(err: RelayerApiError): SendOutcome {
  // err.message can quote the request, and the request carried the API key, so only the code is reported
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
    // an empty parameter is a rotation half done more often than a decision; the webhook and telegram
    // senders treat the same shape of gap as worth another attempt rather than as a dead letter
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
  // the client only knows one bound (it aborts the call once it passes); the tighter of the two deps limits
  // is what actually governs, same as it would if both were enforced independently
  const bounds = [deps.timeoutMs, deps.deadlineMs].filter((n): n is number => n !== undefined)
  if (bounds.length > 0) options.timeoutMs = Math.min(...bounds)
  try {
    // the relayer-client package reaches the network through globalThis.fetch, not node:https - it is meant
    // to run in edge runtimes too and has no runtime dependencies of its own. That is safe here because the
    // URL is deps.relayerApiUrl, operator configuration a rule cannot influence, not a caller-supplied
    // destination that needs the SSRF-pinning guard the other senders go through.
    await submit(options, {
      signerId,
      chainId,
      to,
      data,
      ...(value === undefined ? {} : { value: BigInt(value) }),
      ...(gasLimit === undefined ? {} : { gasLimit: BigInt(gasLimit) }),
      // one key per delivery: a retry after a timeout gets the first transaction back rather than a second one
      idempotencyKey: delivery.deliveryId,
      // the caller's own string, so a downstream project can join the transaction to what caused it
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
