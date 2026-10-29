# @blockwarden/kms-signer

A viem `LocalAccount` backed by an AWS KMS key (`ECC_SECG_P256K1`, `SIGN_VERIFY`). The key never leaves KMS.

```ts
import { toKmsAccount } from '@blockwarden/kms-signer'

const account = await toKmsAccount({ keyId: 'alias/my-signer', region: 'us-east-1' })
```

The caller needs `kms:GetPublicKey` and `kms:Sign` on the key. For tests, `@blockwarden/kms-signer/testing` has an in-memory signer with the same interface.
