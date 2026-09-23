import { relay as relayTx, RelayerApiError } from '@blockwarden/relayer-client'
import { truncate } from '../records.js'
import type { Sender } from './types.js'

// the relayer answers these the same way however often it is asked
const PERMANENT = new Set([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'policy_violation',
  'spend_cap_exceeded',
  'estimate_reverted',
  'estimate_failed',
  'idempotency_conflict',
  'dependency_not_found',
  'dependency_failed',
  'invalid_response',
  'not_found',
])

export const sendRelay: Sender = async (deps, delivery) => {
  if (delivery.target.channel !== 'relay') throw new Error(`delivery ${delivery.deliveryId} is not a relay`)
  if (!deps.relayerApiUrl || !deps.relayerApiKeyParameter) {
    return { kind: 'permanent', error: 'no relayer API is configured for this deployment' }
  }

  let apiKey: string
  try {
    const [first] = await deps.secrets.read(deps.relayerApiKeyParameter)
    apiKey = first!
  } catch (err) {
    return { kind: 'retry', error: truncate(`the relayer API key could not be read: ${(err as Error).message}`) }
  }

  const { signerId, chainId, to, data, value, gasLimit } = delivery.target
  const submit = deps.relay ?? relayTx
  try {
    await submit(
      { baseUrl: deps.relayerApiUrl, apiKey },
      {
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
      },
    )
    return { kind: 'delivered' }
  } catch (err) {
    if (!(err instanceof RelayerApiError)) {
      return { kind: 'retry', error: truncate(`the relayer could not be called: ${(err as Error).message}`) }
    }
    // the message can quote the request, and the request carried the API key
    const message = `the relayer answered ${err.status} ${err.code}`
    return PERMANENT.has(err.code) ? { kind: 'permanent', error: message } : { kind: 'retry', error: message }
  }
}
