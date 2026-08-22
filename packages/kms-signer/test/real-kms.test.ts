import { parseGwei, recoverTransactionAddress, verifyMessage, verifyTypedData } from 'viem'
import { describe, expect, it } from 'vitest'
import { toKmsAccount } from '../src/kms.js'

const keyId = process.env.BLOCKWARDEN_KMS_TEST_KEY_ID

// Needs AWS credentials and an ECC_SECG_P256K1 SIGN_VERIFY key; the region comes from AWS_REGION.
// No emulator signs a digest correctly: moto 5.2.3 hashes the digest again before signing.
describe.skipIf(!keyId)('toKmsAccount against a real KMS key', () => {
  it('signs a message, typed data and a transaction that recover to the key address', async () => {
    const account = await toKmsAccount({ keyId: keyId! })

    const signature = await account.signMessage({ message: 'blockwarden' })
    expect(await verifyMessage({ address: account.address, message: 'blockwarden', signature })).toBe(true)

    const typed = {
      domain: { name: 'Blockwarden', version: '1', chainId: 84532 },
      types: { Check: [{ name: 'value', type: 'uint256' }] },
      primaryType: 'Check',
      message: { value: 1n },
    } as const
    const typedSignature = await account.signTypedData(typed)
    expect(await verifyTypedData({ ...typed, address: account.address, signature: typedSignature })).toBe(true)

    // a few signatures, so both recovery ids and both halves of s are likely to be exercised
    for (let nonce = 0; nonce < 8; nonce++) {
      const serialized = await account.signTransaction({
        type: 'eip1559',
        chainId: 84532,
        nonce,
        to: account.address,
        value: 0n,
        gas: 21_000n,
        maxFeePerGas: parseGwei('1'),
        maxPriorityFeePerGas: parseGwei('1'),
      })
      expect(await recoverTransactionAddress({ serializedTransaction: serialized as `0x02${string}` })).toBe(
        account.address,
      )
    }
  })
})
