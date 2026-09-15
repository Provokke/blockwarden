import { describe, expect, it } from 'vitest'
import { matchKey } from '../src/ids.js'

describe('matchKey', () => {
  const tx = `0x${'11'.repeat(32)}` as const

  it('is stable for the same inputs', () => {
    expect(matchKey(8453, tx, 0, 'r1')).toBe(matchKey(8453, tx, 0, 'r1'))
  })

  it('has the shape of a 32-byte hex hash', () => {
    expect(matchKey(8453, tx, 0, 'r1')).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('changes with the chain, transaction, ordinal and rule', () => {
    const keys = new Set([
      matchKey(8453, tx, 0, 'r1'),
      matchKey(1, tx, 0, 'r1'),
      matchKey(8453, `0x${'12'.repeat(32)}`, 0, 'r1'),
      matchKey(8453, tx, 1, 'r1'),
      matchKey(8453, tx, 0, 'r2'),
    ])
    expect(keys.size).toBe(5)
  })
})
