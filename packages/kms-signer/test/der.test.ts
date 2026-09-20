import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fc from 'fast-check'
import { bytesToHex, keccak256, type Address } from 'viem'
import { describe, expect, it } from 'vitest'
import { encodeDerSignature, InvalidSignatureError, parseDerSignature, SECP256K1_N, toLowS } from '../src/der.js'
import { toRecoverableSignature } from '../src/signature.js'
import { InvalidPublicKeyError, publicKeyFromSpki } from '../src/spki.js'

// OpenSSL is the oracle here: it produces DER the way KMS does, with random nonces, so high s, short r and s,
// and zero-padded integers all turn up without this code having made them
function opensslKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])
  // derived from the JWK coordinates, independently of the SPKI parser under test
  const address = `0x${keccak256(point.subarray(1)).slice(-40)}` as Address
  const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }))
  return { privateKey, address, spki }
}

describe('DER signatures from OpenSSL', () => {
  it('parse, normalise to low s and recover to the key address', async () => {
    const key = opensslKey()
    const seen = { highS: 0, parity1: 0 }
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 64 }), async (message) => {
        const der = new Uint8Array(sign('sha256', message, key.privateKey))
        const digest = bytesToHex(createHash('sha256').update(message).digest())
        const { r, s } = parseDerSignature(der)
        if (s > SECP256K1_N / 2n) seen.highS++

        const signature = await toRecoverableSignature(digest, der, key.address)
        expect(BigInt(signature.r)).toBe(r)
        expect(BigInt(signature.s)).toBe(toLowS(s))
        expect(BigInt(signature.s) <= SECP256K1_N / 2n).toBe(true)
        if (signature.yParity === 1) seen.parity1++
      }),
      { numRuns: 300 },
    )
    // guards against a property that only ever saw the easy half of the input space
    expect(seen.highS).toBeGreaterThan(50)
    expect(seen.parity1).toBeGreaterThan(50)
  })

  it('recovers a signature whose r or s is shorter than 32 bytes', async () => {
    const key = opensslKey()
    // about one signature in 128 has a short integer, so this finds one within a few hundred tries
    for (let i = 0; i < 5000; i++) {
      const message = Buffer.from(`short-${i}`)
      const der = new Uint8Array(sign('sha256', message, key.privateKey))
      const rLength = der[3]!
      if (rLength >= 32 && der[5 + rLength]! >= 32) continue
      const digest = bytesToHex(createHash('sha256').update(message).digest())
      const signature = await toRecoverableSignature(digest, der, key.address)
      expect(BigInt(signature.r)).toBe(parseDerSignature(der).r)
      return
    }
    throw new Error('no short integer in 5000 signatures')
  })

  it('reads the public key out of the SPKI', () => {
    const key = opensslKey()
    const publicKey = publicKeyFromSpki(key.spki)
    expect(`0x${keccak256(`0x${publicKey.slice(4)}`).slice(-40)}`).toBe(key.address)
  })

  it('refuses a key on another curve', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }))
    expect(() => publicKeyFromSpki(spki)).toThrow(InvalidPublicKeyError)
  })

  it('refuses an r that is not the x of any curve point with InvalidSignatureError, not a raw curve error', async () => {
    // x = 5 gives x^3 + 7 with no square root mod p
    const der = encodeDerSignature(5n, 1n)
    const signer = opensslKey()
    await expect(toRecoverableSignature(keccak256('0x01'), der, signer.address)).rejects.toThrow(InvalidSignatureError)
  })

  it('refuses a signature from a different key', async () => {
    const signer = opensslKey()
    const other = opensslKey()
    const der = new Uint8Array(sign('sha256', Buffer.from('x'), signer.privateKey))
    const digest = bytesToHex(createHash('sha256').update('x').digest())
    await expect(toRecoverableSignature(digest, der, other.address)).rejects.toThrow(InvalidSignatureError)
  })
})

describe('parseDerSignature', () => {
  const r = 0x1234n
  const s = 0x80n

  it('reads minimal integers, including one that needs a zero pad byte', () => {
    expect(parseDerSignature(Uint8Array.from([0x30, 0x07, 0x02, 0x02, 0x12, 0x34, 0x02, 0x01, 0x05]))).toEqual({
      r,
      s: 5n,
    })
    expect(parseDerSignature(encodeDerSignature(r, s))).toEqual({ r, s })
    expect([...encodeDerSignature(r, s)]).toEqual([0x30, 0x08, 0x02, 0x02, 0x12, 0x34, 0x02, 0x02, 0x00, 0x80])
  })

  // each body is well formed apart from the one fault named, and the message proves that fault is what was caught
  it.each([
    ['a wrong outer tag', [0x31, 0x08, 0x02, 0x02, 0x12, 0x34, 0x02, 0x02, 0x00, 0x80], /expected a DER sequence/],
    ['a mismatched outer length', [0x30, 0x09, 0x02, 0x02, 0x12, 0x34, 0x02, 0x02, 0x00, 0x80], /does not match/],
    ['a wrong integer tag', [0x30, 0x08, 0x03, 0x02, 0x12, 0x34, 0x02, 0x02, 0x00, 0x80], /expected a DER integer/],
    ['a negative integer', [0x30, 0x07, 0x02, 0x02, 0x12, 0x34, 0x02, 0x01, 0x80], /negative/],
    ['a needless zero pad', [0x30, 0x08, 0x02, 0x02, 0x12, 0x34, 0x02, 0x02, 0x00, 0x05], /minimally/],
    ['a zero-length integer', [0x30, 0x06, 0x02, 0x02, 0x12, 0x34, 0x02, 0x00], /bad DER integer length/],
    ['an integer past the end', [0x30, 0x08, 0x02, 0x02, 0x12, 0x34, 0x02, 0x05, 0x00, 0x80], /bad DER integer length/],
    ['trailing bytes', [0x30, 0x09, 0x02, 0x02, 0x12, 0x34, 0x02, 0x01, 0x05, 0x00, 0x00], /unexpected bytes/],
    ['r equal to zero', [0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x05], /r is outside the curve order/],
  ])('refuses %s', (_, bytes, message) => {
    expect(() => parseDerSignature(Uint8Array.from(bytes))).toThrow(message)
  })

  it('refuses s at or above the curve order', () => {
    expect(() => parseDerSignature(encodeDerSignature(1n, SECP256K1_N))).toThrow(/s is outside the curve order/)
  })
})
