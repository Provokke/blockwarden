import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms'
import { toDigestSignerAccount, type DigestSigner, type KmsAccount } from './account.js'

// only the call this package makes, so a KMSClient from any v3 release, or a stub, fits without a cast
export type KmsClientLike = {
  send(command: GetPublicKeyCommand | SignCommand): Promise<{ PublicKey?: Uint8Array; Signature?: Uint8Array }>
}

export type KmsAccountOptions = {
  keyId: string
  region?: string
  // an existing client, for a custom endpoint, credentials or retry settings
  client?: KmsClientLike
}

export function kmsDigestSigner({ keyId, region, client }: KmsAccountOptions): DigestSigner {
  const kms = client ?? new KMSClient(region ? { region } : {})
  return {
    async getPublicKey() {
      const { PublicKey } = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }))
      if (!PublicKey) throw new Error(`KMS returned no public key for ${keyId}`)
      return PublicKey
    },
    async signDigest(digest) {
      const { Signature } = await kms.send(
        new SignCommand({
          KeyId: keyId,
          Message: digest,
          MessageType: 'DIGEST',
          SigningAlgorithm: 'ECDSA_SHA_256',
        }),
      )
      if (!Signature) throw new Error(`KMS returned no signature for ${keyId}`)
      return Signature
    },
  }
}

// one GetPublicKey call to learn the address; every signature after that is one Sign call
export async function toKmsAccount(options: KmsAccountOptions): Promise<KmsAccount> {
  return toDigestSignerAccount(kmsDigestSigner(options))
}
