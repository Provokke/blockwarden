import { bytesToHex, hexToBigInt, type Hex } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import type { DigestSigner } from './account.js'
import { encodeDerSignature, SECP256K1_N } from './der.js'
import { spkiFromPublicKey } from './spki.js'

// An in-memory stand-in for a KMS key, for tests and local development. Like KMS it returns DER and about half
// of its signatures carry a high s, so code under test has to normalise them as it would for the real thing.
export function createLocalDigestSigner(privateKey: Hex): DigestSigner {
  const { publicKey } = privateKeyToAccount(privateKey)
  return {
    async getPublicKey() {
      return spkiFromPublicKey(publicKey)
    },
    async signDigest(digest) {
      const hash = bytesToHex(digest)
      const { r, s } = await sign({ hash, privateKey })
      const low = hexToBigInt(s)
      // deterministic, so a failing test replays the same signature
      const high = (digest[31]! & 1) === 1
      return encodeDerSignature(hexToBigInt(r), high ? SECP256K1_N - low : low)
    },
  }
}
