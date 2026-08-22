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

`relay` is idempotent per API key: the same `idempotencyKey` returns the original transaction, and a different request under the same key is refused with a 409.

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

The signature header is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. Timestamps more than 300 seconds away are refused, and `secret` can be a list while a secret rotates. Use `X-Blockwarden-Delivery` (also `event.id`) to ignore a delivery you have already handled.
