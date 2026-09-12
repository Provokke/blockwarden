import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms'
import { generateKeyPairSync } from 'node:crypto'
import { keccak256, verifyMessage, verifyTypedData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { InvalidSignatureError } from '../src/der.js'
import { InvalidPublicKeyError } from '../src/spki.js'
import { kmsDigestSigner, toKmsAccount, type KmsClientLike } from '../src/kms.js'
import { createLocalDigestSigner } from '../src/testing.js'

const PRIVATE_KEY = `0x${'55'.repeat(32)}` as const
const KEY_ID = 'arn:aws:kms:us-east-1:111122223333:key/test'

// answers the two KMS calls from a local key and records what it was asked
function fakeKms(options: { publicKey?: Uint8Array; signWith?: `0x${string}` } = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = []
  // no cast: any object with a matching send is a client, not only the SDK's own class
  const client: KmsClientLike = {
    async send(command: GetPublicKeyCommand | SignCommand) {
      calls.push({ name: command.constructor.name, input: { ...command.input } })
      if (command instanceof GetPublicKeyCommand) {
        return { PublicKey: options.publicKey ?? (await createLocalDigestSigner(PRIVATE_KEY).getPublicKey()) }
      }
      const signer = createLocalDigestSigner(options.signWith ?? PRIVATE_KEY)
      return { Signature: await signer.signDigest(command.input.Message as Uint8Array) }
    },
  }
  return { client, calls }
}

describe('toKmsAccount', () => {
  it('asks KMS to sign the digest itself with ECDSA_SHA_256, and the result verifies', async () => {
    const kms = fakeKms()
    const account = await toKmsAccount({ keyId: KEY_ID, client: kms.client })
    expect(account.address).toBe(privateKeyToAccount(PRIVATE_KEY).address)

    const signature = await account.signMessage({ message: 'charge' })
    expect(await verifyMessage({ address: account.address, message: 'charge', signature })).toBe(true)
    expect(kms.calls.map((c) => c.name)).toEqual(['GetPublicKeyCommand', 'SignCommand'])
    expect(kms.calls[0]!.input).toEqual({ KeyId: KEY_ID })
    expect(kms.calls[1]!.input).toMatchObject({
      KeyId: KEY_ID,
      MessageType: 'DIGEST',
      SigningAlgorithm: 'ECDSA_SHA_256',
    })
    expect((kms.calls[1]!.input.Message as Uint8Array).length).toBe(32)
  })

  it('signs EIP-712 typed data such as a paymaster sponsorship, and reads the public key only once', async () => {
    const kms = fakeKms()
    const account = await toKmsAccount({ keyId: KEY_ID, client: kms.client })
    const sponsorship = {
      domain: {
        name: 'Paymaster',
        version: '1',
        chainId: 84532,
        verifyingContract: '0x000000000000000000000000000000000000bEEF',
      },
      types: {
        Sponsorship: [
          { name: 'userOpHash', type: 'bytes32' },
          { name: 'validUntil', type: 'uint48' },
          { name: 'validAfter', type: 'uint48' },
        ],
      },
      primaryType: 'Sponsorship',
      message: { userOpHash: keccak256('0x01'), validUntil: 1_800_000_000, validAfter: 1_700_000_000 },
    } as const
    for (let i = 0; i < 4; i++) {
      const message = { ...sponsorship.message, validUntil: sponsorship.message.validUntil + i }
      const signature = await account.signTypedData({ ...sponsorship, message })
      expect(await verifyTypedData({ ...sponsorship, message, address: account.address, signature })).toBe(true)
    }
    expect(kms.calls.map((c) => c.name)).toEqual([
      'GetPublicKeyCommand',
      'SignCommand',
      'SignCommand',
      'SignCommand',
      'SignCommand',
    ])
  })

  it('refuses a key that is not secp256k1', async () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const kms = fakeKms({ publicKey: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })) })
    const refused = toKmsAccount({ keyId: KEY_ID, client: kms.client })
    await expect(refused).rejects.toThrow(InvalidPublicKeyError)
    await expect(refused).rejects.toThrow(/ECC_SECG_P256K1/)
  })

  it('refuses a signature that does not recover to the key address', async () => {
    const kms = fakeKms({ signWith: `0x${'66'.repeat(32)}` })
    const account = await toKmsAccount({ keyId: KEY_ID, client: kms.client })
    await expect(account.signMessage({ message: 'x' })).rejects.toThrow(InvalidSignatureError)
  })

  it('reports an empty KMS answer instead of signing with nothing', async () => {
    const client: KmsClientLike = { send: async () => ({}) }
    const signer = kmsDigestSigner({ keyId: KEY_ID, client })
    await expect(signer.getPublicKey()).rejects.toThrow(/no public key/)
    await expect(signer.signDigest(new Uint8Array(32))).rejects.toThrow(/no signature/)
  })

  it('takes a KMSClient from @aws-sdk/client-kms as its client', () => {
    expectTypeOf<KMSClient>().toExtend<KmsClientLike>()
    const client: KmsClientLike = new KMSClient({ region: 'us-east-1' })
    expect(kmsDigestSigner({ keyId: KEY_ID, client })).toBeDefined()
  })
})
