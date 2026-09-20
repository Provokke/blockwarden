import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nextDelaySeconds } from '../../src/backoff.js'

// the middle of the jitter band
const mid = () => 0.5

describe('nextDelaySeconds', () => {
  it('triples each time and stops at fifteen minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => nextDelaySeconds(n, undefined, mid))).toEqual([
      10, 30, 90, 270, 810, 900, 900,
    ])
  })

  it('jitters by at most a fifth either way', () => {
    expect(nextDelaySeconds(3, undefined, () => 0)).toBe(72)
    expect(nextDelaySeconds(3, undefined, () => 1)).toBe(108)
  })

  it('never goes below one second or above nine hundred', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.double({ min: 0, max: 1, noNaN: true }), (attempts, r) => {
        const delay = nextDelaySeconds(attempts, undefined, () => r)
        expect(delay).toBeGreaterThanOrEqual(1)
        expect(delay).toBeLessThanOrEqual(900)
        expect(Number.isInteger(delay)).toBe(true)
      }),
      { numRuns: 500 },
    )
  })

  it('lets a retry-after lengthen a wait', () => {
    expect(nextDelaySeconds(1, 120, mid)).toBe(120)
  })

  it('does not let a retry-after shorten one', () => {
    expect(nextDelaySeconds(5, 1, mid)).toBe(810)
  })

  it('ignores a retry-after that is not a sane number', () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(nextDelaySeconds(2, bad, mid)).toBe(30)
    }
  })

  it("caps a very long retry-after at the queue's limit", () => {
    expect(nextDelaySeconds(1, 86_400, mid)).toBe(900)
  })
})
