# @blockwarden/relayer-client

A typed client for the [Blockwarden](https://github.com/Provokke/blockwarden) relayer API, and webhook verification. No dependencies; it runs anywhere with `fetch` and Web Crypto.

```ts
import { getTx, listSigners, relay, RelayerApiError } from '@blockwarden/relayer-client'

const options = { baseUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com', apiKey: process.env.RELAYER_API_KEY! }

const [signer] = await listSigners(options)
try {
  const tx = await relay(options, {
    signerId: signer.signerId,
    chainId: 84532,
    to: '0x...',
    data: '0x...',
    idempotencyKey: 'charge:sub_1:period_3',
    reference: 'sub_1',
  })
  const latest = await getTx(options, tx.txId)
  // queued, submitted, mined, confirmed or failed; once mined, receiptStatus says success or reverted
  console.log(latest.status, latest.receiptStatus, latest.hash, latest.blockNumber)
} catch (err) {
  // a 422 from a reverting gas estimate carries the revert data, for decoding custom errors
  if (err instanceof RelayerApiError && err.code === 'estimate_reverted') console.log(err.revertData)
  throw err
}
```

`relay` is idempotent per API key: the same `idempotencyKey` returns the original transaction, and a different request under the same key is refused with a 409. A key is remembered for 24 hours. DynamoDB deletes expired keys up to about a day late, so a key can still count as a duplicate for up to about 48 hours; do not reuse one on purpose.

Every API key that may use a signer can read that signer's transactions with `getTx`, whichever key submitted them. Give separate signers to callers that must not see each other's transactions.

## Errors

`relay`, `getTx` and `listSigners` reject only with `RelayerApiError`, which carries `status`, `code`, `message`, `issues` and `revertData`:

| `code` | `status` | Meaning |
|---|---|---|
| `network_error` | 0 | The relayer could not be reached, or the request timed out (`timeoutMs`, default 10 seconds). `cause` holds the underlying error. The request may still have arrived, so retry `relay` with the same `idempotencyKey`. |
| `invalid_response` | 2xx | The relayer answered with a body that is not the expected shape. |
| `throttled` | 429 | API Gateway refused the request for its rate limit. `message` is API Gateway's own. |
| `http_error` | other | A failure without a relayer error body, such as an API Gateway 404 or a 502. `message` is API Gateway's own when it sent one. |
| anything else | 4xx, 5xx | The relayer's own error, such as `invalid_request`, `unauthorized`, `policy_violation`, `spend_cap_exceeded`, `estimate_reverted`, `idempotency_conflict`, `busy` or `rpc_unavailable`. |

`dependsOn` holds a transaction until an earlier one is confirmed, for a call that reverts until that one is mined. The dependency must be on the same chain and a signer this API key may use, and the request needs an explicit `gasLimit` (there is no estimate to derive it from until the dependency lands). If the dependency fails, is cancelled or reverts, the dependent fails too, with `error` set and no attempt made. A bad `dependsOn` is refused with `dependency_not_found` (missing, wrong chain, or a signer this key may not use) or `dependency_failed` (already failed, cancelled or reverted).

## Webhooks

```ts
import { isTxEvent, parseTx, verifyWebhook } from '@blockwarden/relayer-client'

const event = await verifyWebhook({
  payload: rawBody, // the body exactly as received
  signature: request.headers.get('x-blockwarden-signature'),
  secret: process.env.BLOCKWARDEN_WEBHOOK_SECRET!,
})
if (isTxEvent(event)) console.log(event.type, parseTx(event.data).status)
```

The signature header is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. Timestamps more than 300 seconds away are refused, and `secret` can be a list while a secret rotates. Use `X-Blockwarden-Delivery` (also `event.id`) to ignore a delivery you have already handled. Each status change gets its own delivery id, so a transaction reorged out and mined again sends a second `tx.mined` with a new id.

`isTxEvent` checks that the type is `tx.` followed by a known status and that `data` has every field of a transaction, so `parseTx` can read it. `signWebhook` refuses an empty secret, and `verifyWebhook` throws `WebhookVerificationError` for a secret that is empty or not a string.
