# @blockwarden/relayer-client

A typed client for the Blockwarden relayer API, plus webhook verification. No dependencies; it needs `fetch` and Web Crypto.

```ts
import { relay, verifyWebhook } from '@blockwarden/relayer-client'

const options = { baseUrl: 'https://example.execute-api.us-east-1.amazonaws.com', apiKey: process.env.RELAYER_API_KEY! }
const tx = await relay(options, { signerId, chainId: 84532, to: '0x...', data: '0x...', idempotencyKey: 'charge:1' })

// in your webhook handler
const event = await verifyWebhook({ payload: rawBody, signature, secret })
```

Calls reject with `RelayerApiError`. Webhook delivery is at least once, so dedupe on `event.id`.
