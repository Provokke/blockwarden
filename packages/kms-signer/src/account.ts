import {
  hashMessage,
  hashTypedData,
  hexToBytes,
  keccak256,
  serializeSignature,
  serializeTransaction,
  type Hex,
  type LocalAccount,
} from 'viem'
import { publicKeyToAddress, toAccount } from 'viem/accounts'
import { toRecoverableSignature } from './signature.js'
import { publicKeyFromSpki } from './spki.js'

// the two calls a secp256k1 key has to answer; AWS KMS is one implementation, an in-memory key is another
export type DigestSigner = {
  // DER SubjectPublicKeyInfo, as KMS GetPublicKey returns it
  getPublicKey(): Promise<Uint8Array>
  // DER ECDSA signature over the 32-byte digest itself, with no further hashing
  signDigest(digest: Uint8Array): Promise<Uint8Array>
}

export type KmsAccount = LocalAccount<'kms'>

export async function toDigestSignerAccount(signer: DigestSigner): Promise<KmsAccount> {
  const publicKey = publicKeyFromSpki(await signer.getPublicKey())
  const address = publicKeyToAddress(publicKey)
  const signHash = async (hash: Hex) => toRecoverableSignature(hash, await signer.signDigest(hexToBytes(hash)), address)

  const account = toAccount({
    address,
    async sign({ hash }) {
      return serializeSignature(await signHash(hash))
    },
    async signMessage({ message }) {
      return serializeSignature(await signHash(hashMessage(message)))
    },
    async signTypedData(typedData) {
      return serializeSignature(await signHash(hashTypedData(typedData)))
    },
    async signTransaction(transaction, options) {
      // a blob transaction is signed without its sidecars, which this account has no test for, so it refuses one
      if (transaction.type === 'eip4844') throw new Error('blob transactions are not supported')
      const serializer = options?.serializer ?? serializeTransaction
      const signature = await signHash(keccak256(await serializer(transaction)))
      return serializer(transaction, signature)
    },
  })
  return { ...account, publicKey, source: 'kms' }
}
