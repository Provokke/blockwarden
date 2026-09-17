import { createPublicKey, verify } from 'node:crypto'
import fc from 'fast-check'
import {
  bytesToHex,
  keccak256,
  parseGwei,
  recoverTransactionAddress,
  verifyMessage,
  verifyTypedData,
  type Hex,
  type TransactionSerializable,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { toDigestSignerAccount } from '../src/account.js'
import { parseDerSignature, SECP256K1_N } from '../src/der.js'
import { createLocalDigestSigner } from '../src/testing.js'

const privateKeys = fc.uint8Array({ minLength: 32, maxLength: 32 }).filter((bytes) => {
  const k = BigInt(bytesToHex(bytes))
  return k > 0n && k < SECP256K1_N
})

const typedData = (value: bigint) =>
  ({
    domain: {
      name: 'Paymaster',
      version: '1',
      chainId: 84532,
      verifyingContract: '0x000000000000000000000000000000000000dEaD',
    },
    types: {
      Approval: [
        { name: 'sender', type: 'address' },
        { name: 'value', type: 'uint256' },
      ],
    },
    primaryType: 'Approval',
    message: { sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', value },
  }) as const

const transaction = (nonce: number, data: Hex): TransactionSerializable => ({
  type: 'eip1559',
  chainId: 84532,
  nonce,
  to: '0x000000000000000000000000000000000000dEaD',
  value: 1n,
  data,
  gas: 100_000n,
  maxFeePerGas: parseGwei('2'),
  maxPriorityFeePerGas: parseGwei('1'),
})

describe('createLocalDigestSigner', () => {
  it('returns DER that OpenSSL verifies against the digest, with high s about half the time', async () => {
    const privateKey = `0x${'11'.repeat(32)}` as const
    const signer = createLocalDigestSigner(privateKey)
    const key = createPublicKey({ key: Buffer.from(await signer.getPublicKey()), format: 'der', type: 'spki' })
    let high = 0
    for (let i = 0; i < 64; i++) {
      const message = Buffer.from(`message ${i}`)
      // OpenSSL hashes with SHA-256 before verifying, so sign the SHA-256 of the message as the digest
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message))
      const der = await signer.signDigest(digest)
      expect(verify('sha256', message, key, der)).toBe(true)
      if (parseDerSignature(der).s > SECP256K1_N / 2n) high++
    }
    expect(high).toBeGreaterThan(10)
    expect(high).toBeLessThan(54)
  })
})

describe('toDigestSignerAccount', () => {
  // viem's own account signs with RFC 6979 and low s; the digest signer uses the same nonce, so once s is
  // normalised every signature must match byte for byte
  it('signs exactly as a viem private key account does', async () => {
    await fc.assert(
      fc.asyncProperty(
        privateKeys,
        fc.string(),
        fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }),
        fc.nat({ max: 1000 }),
        fc.uint8Array({ maxLength: 64 }),
        async (keyBytes, message, value, nonce, data) => {
          const privateKey = bytesToHex(keyBytes)
          const expected = privateKeyToAccount(privateKey)
          const account = await toDigestSignerAccount(createLocalDigestSigner(privateKey))
          const tx = transaction(nonce, bytesToHex(data))

          expect(account.address).toBe(expected.address)
          expect(account.publicKey).toBe(expected.publicKey)
          expect(account.source).toBe('kms')
          expect(await account.signMessage({ message })).toBe(await expected.signMessage({ message }))
          expect(await account.signTypedData(typedData(value))).toBe(await expected.signTypedData(typedData(value)))
          expect(await account.signTransaction(tx)).toBe(await expected.signTransaction(tx))
          const hash = keccak256(bytesToHex(data))
          expect(await account.sign!({ hash })).toBe(await expected.sign({ hash }))
        },
      ),
      { numRuns: 40 },
    )
  })

  it('produces signatures that verify and recover to the account', async () => {
    const account = await toDigestSignerAccount(createLocalDigestSigner(`0x${'22'.repeat(32)}`))
    const signature = await account.signMessage({ message: 'hello' })
    expect(await verifyMessage({ address: account.address, message: 'hello', signature })).toBe(true)
    const typed = typedData(5n)
    expect(
      await verifyTypedData({ ...typed, address: account.address, signature: await account.signTypedData(typed) }),
    ).toBe(true)
    const serialized = await account.signTransaction(transaction(7, '0x1234'))
    expect(await recoverTransactionAddress({ serializedTransaction: serialized as never })).toBe(account.address)
  })

  it('signs a legacy transaction too', async () => {
    const privateKey = `0x${'33'.repeat(32)}` as const
    const account = await toDigestSignerAccount(createLocalDigestSigner(privateKey))
    const legacy: TransactionSerializable = {
      type: 'legacy',
      chainId: 1,
      nonce: 0,
      gas: 21_000n,
      gasPrice: 1n,
      to: account.address,
      value: 0n,
    }
    expect(await account.signTransaction(legacy)).toBe(await privateKeyToAccount(privateKey).signTransaction(legacy))
  })

  it('refuses a blob transaction rather than sign it with its sidecars', async () => {
    const account = await toDigestSignerAccount(createLocalDigestSigner(`0x${'44'.repeat(32)}`))
    const blob = {
      ...transaction(0, '0x'),
      type: 'eip4844',
      blobVersionedHashes: [`0x01${'00'.repeat(31)}`],
      maxFeePerBlobGas: 1n,
    } as const
    await expect(account.signTransaction(blob as TransactionSerializable)).rejects.toThrow(/blob transactions/)
  })
})
