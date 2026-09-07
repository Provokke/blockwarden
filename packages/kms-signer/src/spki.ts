import { bytesToHex, type Hex } from 'viem'

// SubjectPublicKeyInfo header for an uncompressed secp256k1 point: id-ecPublicKey, secp256k1, BIT STRING of 66 bytes
const SECP256K1_SPKI_HEADER = '3056301006072a8648ce3d020106052b8104000a034200'

export class InvalidPublicKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPublicKeyError'
  }
}

export function publicKeyFromSpki(spki: Uint8Array): Hex {
  const header = bytesToHex(spki.subarray(0, 23)).slice(2)
  if (spki.length !== 88 || header !== SECP256K1_SPKI_HEADER || spki[23] !== 0x04) {
    throw new InvalidPublicKeyError('the key is not an uncompressed secp256k1 public key (ECC_SECG_P256K1)')
  }
  return bytesToHex(spki.subarray(23))
}

export function spkiFromPublicKey(publicKey: Hex): Uint8Array {
  return Uint8Array.from(Buffer.from(`${SECP256K1_SPKI_HEADER}${publicKey.slice(2)}`, 'hex'))
}
