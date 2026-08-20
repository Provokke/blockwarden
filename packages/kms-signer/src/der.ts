export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

export class InvalidSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSignatureError'
  }
}

// KMS returns ECDSA signatures as DER: SEQUENCE { INTEGER r, INTEGER s }. Anything looser is refused,
// because a lenient parser can read a different (r, s) out of a malformed body.
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  if (der.length < 8 || der[0] !== 0x30) throw new InvalidSignatureError('expected a DER sequence')
  if (der[1] !== der.length - 2) throw new InvalidSignatureError('DER sequence length does not match the body')
  const r = readInteger(der, 2)
  const s = readInteger(der, r.end)
  if (s.end !== der.length) throw new InvalidSignatureError('unexpected bytes after the DER sequence')
  for (const [name, value] of [
    ['r', r.value],
    ['s', s.value],
  ] as const) {
    if (value === 0n || value >= SECP256K1_N) throw new InvalidSignatureError(`${name} is outside the curve order`)
  }
  return { r: r.value, s: s.value }
}

function readInteger(der: Uint8Array, offset: number): { value: bigint; end: number } {
  if (der[offset] !== 0x02) throw new InvalidSignatureError('expected a DER integer')
  const length = der[offset + 1] ?? 0
  const start = offset + 2
  const end = start + length
  if (length < 1 || length > 33 || end > der.length) throw new InvalidSignatureError('bad DER integer length')
  const first = der[start]!
  if (first & 0x80) throw new InvalidSignatureError('negative DER integer')
  if (length > 1 && first === 0 && !(der[start + 1]! & 0x80)) {
    throw new InvalidSignatureError('DER integer is not minimally encoded')
  }
  let value = 0n
  for (let i = start; i < end; i++) value = (value << 8n) | BigInt(der[i]!)
  return { value, end }
}

// EIP-2: Ethereum only accepts s in the lower half of the curve order; (r, n - s) signs the same hash
export function toLowS(s: bigint): bigint {
  return s > SECP256K1_N / 2n ? SECP256K1_N - s : s
}

export function encodeDerSignature(r: bigint, s: bigint): Uint8Array {
  const integer = (value: bigint) => {
    let bytes = Buffer.from(value.toString(16).padStart(64, '0'), 'hex')
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    bytes = bytes.subarray(start)
    // a set top bit would read as negative, so DER prefixes a zero byte
    const body = bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes
    return Buffer.concat([Buffer.from([0x02, body.length]), body])
  }
  const body = Buffer.concat([integer(r), integer(s)])
  return Uint8Array.from(Buffer.concat([Buffer.from([0x30, body.length]), body]))
}
