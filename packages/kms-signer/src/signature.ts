import { isAddressEqual, numberToHex, recoverAddress, type Address, type Hex } from 'viem'
import { InvalidSignatureError, parseDerSignature, toLowS } from './der.js'

// v as well as yParity, because a legacy transaction serialises v
export type RecoverableSignature = { r: Hex; s: Hex; v: bigint; yParity: 0 | 1 }

// DER carries no recovery id, so try both and keep the one that gives back this key's address
export async function toRecoverableSignature(
  hash: Hex,
  der: Uint8Array,
  address: Address,
): Promise<RecoverableSignature> {
  const { r, s } = parseDerSignature(der)
  const low = { r: numberToHex(r, { size: 32 }), s: numberToHex(toLowS(s), { size: 32 }) }
  for (const yParity of [0, 1] as const) {
    const signature = { ...low, v: yParity === 1 ? 28n : 27n, yParity }
    let recovered: Address
    try {
      recovered = await recoverAddress({ hash, signature })
    } catch {
      // an r that is not on the curve recovers nothing
      throw new InvalidSignatureError('the signature does not recover to any address')
    }
    if (isAddressEqual(recovered, address)) return signature
  }
  throw new InvalidSignatureError(`the signature does not recover to ${address}`)
}
