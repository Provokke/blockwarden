# @blockwarden/kms-signer

A [viem](https://viem.sh) `LocalAccount` whose key lives in AWS KMS. The key is an `ECC_SECG_P256K1` `SIGN_VERIFY` key and never leaves KMS.

```ts
import { toKmsAccount } from '@blockwarden/kms-signer'
import { createWalletClient, http } from 'viem'
import { baseSepolia } from 'viem/chains'

const account = await toKmsAccount({ keyId: 'alias/my-signer', region: 'us-east-1' })
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() })
await wallet.sendTransaction({ to: '0x...', value: 1n })
```

`toKmsAccount` reads the public key once, to learn the address, and every signature after that is one KMS `Sign` call over the digest. It implements `sign`, `signMessage`, `signTypedData` and `signTransaction`. KMS returns DER signatures; the account normalises `s` to the lower half of the curve (EIP-2) and finds the recovery id by recovering its own address. Blob transactions are refused.

Pass `client` to reuse a `KMSClient` with your own endpoint, credentials or retry settings.

The caller needs `kms:GetPublicKey` and `kms:Sign` on the key.

## Testing without KMS

KMS emulators do not sign digests correctly: moto 5.2.3 hashes the digest again before signing. `@blockwarden/kms-signer/testing` provides an in-memory key behind the same interface. Like KMS, it returns DER and about half of its signatures have a high `s`.

```ts
import { toDigestSignerAccount } from '@blockwarden/kms-signer'
import { createLocalDigestSigner } from '@blockwarden/kms-signer/testing'

const account = await toDigestSignerAccount(createLocalDigestSigner('0x<32-byte private key>'))
```

Its signatures are byte for byte the same as viem's `privateKeyToAccount` for the same key.
