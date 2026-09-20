import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { bumpFees, clampFees, isAcceptedReplacement, minReplacementFees, type Fees } from '../src/fees.js'

const fees = (maxFeePerGas: bigint, maxPriorityFeePerGas: bigint): Fees => ({ maxFeePerGas, maxPriorityFeePerGas })
const gwei = 1_000_000_000n

// a valid EIP-1559 pair: the tip never exceeds the fee cap
const feePair = (limit: bigint) =>
  fc
    .tuple(fc.bigInt({ min: 0n, max: limit }), fc.bigInt({ min: 0n, max: limit }))
    .map(([a, b]) => (a >= b ? fees(a, b) : fees(b, a)))

const ceil1125 = (v: bigint) => (v * 1125n + 999n) / 1000n
const least = (a: bigint, b: bigint) => (a < b ? a : b)
const most = (a: bigint, b: bigint) => (a > b ? a : b)

describe('isAcceptedReplacement', () => {
  it('follows geth: both fields must rise and reach 110%, rounded down', () => {
    const old = fees(2n * gwei, 1n * gwei)
    expect(isAcceptedReplacement(old, fees(2_200_000_000n, 1_100_000_000n))).toBe(true)
    expect(isAcceptedReplacement(old, fees(2_199_999_999n, 1_100_000_000n))).toBe(false)
    expect(isAcceptedReplacement(old, fees(2_200_000_000n, 1_099_999_999n))).toBe(false)
    expect(isAcceptedReplacement(old, fees(3n * gwei, 1n * gwei))).toBe(false)
  })

  it('needs a strict rise at wei level, where 110% rounds down to the old value', () => {
    expect(isAcceptedReplacement(fees(9n, 0n), fees(9n, 1n))).toBe(false)
    expect(isAcceptedReplacement(fees(9n, 0n), fees(10n, 1n))).toBe(true)
    expect(isAcceptedReplacement(fees(0n, 0n), fees(1n, 1n))).toBe(true)
  })
})

describe('minReplacementFees', () => {
  it('is the least accepted replacement in each field', () => {
    fc.assert(
      fc.property(feePair(10n ** 12n), (old) => {
        const min = minReplacementFees(old)
        expect(isAcceptedReplacement(old, min)).toBe(true)
        expect(isAcceptedReplacement(old, fees(min.maxFeePerGas - 1n, min.maxPriorityFeePerGas))).toBe(false)
        expect(isAcceptedReplacement(old, fees(min.maxFeePerGas, min.maxPriorityFeePerGas - 1n))).toBe(false)
      }),
    )
  })
})

describe('clampFees', () => {
  it('never exceeds the cap and keeps the tip at or below the fee cap', () => {
    fc.assert(
      fc.property(feePair(10n ** 12n), feePair(10n ** 12n), (estimate, cap) => {
        const clamped = clampFees(estimate, cap)
        expect(clamped.maxFeePerGas).toBeLessThanOrEqual(cap.maxFeePerGas)
        expect(clamped.maxPriorityFeePerGas).toBeLessThanOrEqual(cap.maxPriorityFeePerGas)
        expect(clamped.maxPriorityFeePerGas).toBeLessThanOrEqual(clamped.maxFeePerGas)
      }),
    )
  })

  it('pulls a tip above the fee cap down to the fee cap, as a node refuses it otherwise', () => {
    expect(clampFees(fees(5n * gwei, 7n * gwei), fees(100n * gwei, 100n * gwei))).toEqual(fees(5n * gwei, 5n * gwei))
  })
})

describe('bumpFees', () => {
  it('returns a replacement the node accepts within the cap, or refuses only when no fee under the cap is accepted', () => {
    let replaced = 0
    let refused = 0
    fc.assert(
      fc.property(
        feePair(100n * gwei),
        feePair(100n * gwei),
        // headroom over the previous fees, in percent, so the cap lands on both sides of the node minimum
        fc.bigInt({ min: 0n, max: 30n }),
        fc.bigInt({ min: 0n, max: 30n }),
        (previous, estimate, feeHeadroom, tipHeadroom) => {
          const capFee = previous.maxFeePerGas + (previous.maxFeePerGas * feeHeadroom) / 100n + 1n
          const capTip = previous.maxPriorityFeePerGas + (previous.maxPriorityFeePerGas * tipHeadroom) / 100n + 1n
          const cap = fees(capFee, least(capTip, capFee))
          const result = bumpFees(previous, estimate, cap)
          if (result.ok) {
            replaced++
            const next = result.fees
            expect(isAcceptedReplacement(previous, next)).toBe(true)
            expect(next.maxFeePerGas).toBeLessThanOrEqual(cap.maxFeePerGas)
            expect(next.maxPriorityFeePerGas).toBeLessThanOrEqual(cap.maxPriorityFeePerGas)
            expect(next.maxPriorityFeePerGas).toBeLessThanOrEqual(next.maxFeePerGas)
            expect(next.maxFeePerGas).toBeGreaterThanOrEqual(
              least(most(ceil1125(previous.maxFeePerGas), estimate.maxFeePerGas), cap.maxFeePerGas),
            )
            expect(next.maxPriorityFeePerGas).toBeGreaterThanOrEqual(
              least(
                most(ceil1125(previous.maxPriorityFeePerGas), estimate.maxPriorityFeePerGas),
                least(cap.maxPriorityFeePerGas, next.maxFeePerGas),
              ),
            )
          } else {
            refused++
            expect(result.required).toEqual(minReplacementFees(previous))
            // the cap is the highest candidate, so when it is refused every fee under the cap is refused too
            expect(isAcceptedReplacement(previous, cap)).toBe(false)
          }
        },
      ),
      { numRuns: 2000 },
    )
    // without these the property could pass on a generator that only ever reaches one branch
    expect(replaced).toBeGreaterThan(200)
    expect(refused).toBeGreaterThan(200)
  })

  it('raises by 12.5% when the estimate is lower', () => {
    const result = bumpFees(fees(8n * gwei, 2n * gwei), fees(1n * gwei, 1n), fees(100n * gwei, 100n * gwei))
    expect(result).toEqual({ ok: true, fees: fees(9n * gwei, 2_250_000_000n) })
  })

  it('follows the estimate when it is more than 12.5% higher', () => {
    const result = bumpFees(fees(8n * gwei, 2n * gwei), fees(20n * gwei, 3n * gwei), fees(100n * gwei, 100n * gwei))
    expect(result).toEqual({ ok: true, fees: fees(20n * gwei, 3n * gwei) })
  })

  it('stops at the cap when the cap still clears the node minimum', () => {
    const result = bumpFees(fees(8n * gwei, 2n * gwei), fees(1n, 1n), fees(8_900_000_000n, 2_200_000_000n))
    expect(result).toEqual({ ok: true, fees: fees(8_900_000_000n, 2_200_000_000n) })
  })

  it('refuses when the cap is below the node minimum on either field', () => {
    const previous = fees(8n * gwei, 2n * gwei)
    const required = fees(8_800_000_000n, 2_200_000_000n)
    expect(bumpFees(previous, fees(1n, 1n), fees(8_799_999_999n, 3n * gwei))).toEqual({ ok: false, required })
    expect(bumpFees(previous, fees(1n, 1n), fees(9n * gwei, 2_199_999_999n))).toEqual({ ok: false, required })
  })

  it('moves a zero tip to one wei', () => {
    expect(bumpFees(fees(10n, 0n), fees(0n, 0n), fees(100n, 100n))).toEqual({ ok: true, fees: fees(12n, 1n) })
  })
})
