import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { evaluate } from '../src/conditions.js'

const ctx = {
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  blockNumber: 100,
  args: {
    from: '0x00000000000000000000000000000000000000AA',
    value: 1500n,
    decimals: 6,
    ok: true,
    ids: [1n, 2n, 3n],
  },
}

describe('evaluate', () => {
  it('matches everything when there are no conditions', () => {
    expect(evaluate(undefined, ctx)).toBe(true)
  })

  it('compares uint256 values as bigints', () => {
    expect(evaluate({ field: 'args.value', op: 'gte', value: '1500' }, ctx)).toBe(true)
    expect(evaluate({ field: 'args.value', op: 'gt', value: '1500' }, ctx)).toBe(false)
    expect(evaluate({ field: 'args.value', op: 'lt', value: 2000 }, ctx)).toBe(true)
  })

  it('compares small integers that viem decodes as numbers', () => {
    expect(evaluate({ field: 'args.decimals', op: 'eq', value: '6' }, ctx)).toBe(true)
  })

  it('compares hex strings case-insensitively', () => {
    expect(evaluate({ field: 'args.from', op: 'eq', value: '0x00000000000000000000000000000000000000aa' }, ctx)).toBe(
      true,
    )
    expect(
      evaluate({ field: 'address', op: 'in', value: ['0x1', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'] }, ctx),
    ).toBe(true)
  })

  it('treats a missing field as no match for every operator', () => {
    for (const op of ['eq', 'neq', 'gt', 'in', 'contains'] as const) {
      expect(evaluate({ field: 'args.nope', op, value: op === 'in' ? ['1'] : '1' }, ctx)).toBe(false)
    }
  })

  it('does not walk into prototype properties', () => {
    expect(evaluate({ field: 'args.constructor', op: 'neq', value: 'x' }, ctx)).toBe(false)
  })

  it('handles contains on arrays and booleans on eq', () => {
    expect(evaluate({ field: 'args.ids', op: 'contains', value: '2' }, ctx)).toBe(true)
    expect(evaluate({ field: 'args.ok', op: 'eq', value: true }, ctx)).toBe(true)
  })

  it('combines all and any groups', () => {
    const condition = {
      all: [
        { field: 'args.value', op: 'gte' as const, value: '1000' },
        {
          any: [
            { field: 'args.decimals', op: 'eq' as const, value: 18 },
            { field: 'args.ok', op: 'eq' as const, value: true },
          ],
        },
      ],
    }
    expect(evaluate(condition, ctx)).toBe(true)
  })

  it('agrees with native bigint ordering for any uint256 pair', () => {
    const uint256 = fc.bigInt({ min: 0n, max: 2n ** 256n - 1n })
    fc.assert(
      fc.property(uint256, uint256, (a, b) => {
        const values = { args: { value: a } }
        expect(evaluate({ field: 'args.value', op: 'gte', value: b.toString() }, values)).toBe(a >= b)
        expect(evaluate({ field: 'args.value', op: 'lt', value: b.toString() }, values)).toBe(a < b)
        expect(evaluate({ field: 'args.value', op: 'eq', value: b.toString() }, values)).toBe(a === b)
      }),
    )
  })
})
