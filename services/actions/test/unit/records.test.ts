import { describe, expect, it } from 'vitest'
import { keys } from '../../src/keys.js'
import { MAX_ERROR_CHARACTERS, TERMINAL, truncate } from '../../src/records.js'

describe('keys', () => {
  it('puts a delivery under the item it belongs to', () => {
    expect(keys.delivery(keys.matchSubject('0xabc'), 'a_00112233aabbccdd', 'match.final', 0)).toEqual({
      PK: 'MATCH#0xabc',
      SK: 'DELIVERY#a_00112233aabbccdd#match.final#0000',
    })
  })

  it('pads the sequence so the sort key orders history entries as numbers', () => {
    const nine = keys.delivery(keys.txSubject('t1'), 'a_00112233aabbccdd', 'tx.mined', 9).SK
    const ten = keys.delivery(keys.txSubject('t1'), 'a_00112233aabbccdd', 'tx.mined', 10).SK
    expect(nine < ten).toBe(true)
    expect(ten).toBe('DELIVERY#a_00112233aabbccdd#tx.mined#0010')
  })

  it('names the three subject kinds apart', () => {
    expect(keys.matchSubject('k')).toBe('MATCH#k')
    expect(keys.txSubject('k')).toBe('TX#k')
    expect(keys.outboundSubject('k')).toBe('OUTBOUND#k')
  })

  it('has one partition for due deliveries and one per listed status', () => {
    expect(keys.dueDeliveries()).toBe('DELIVERY#DUE')
    expect(keys.deliveriesByStatus('dead')).toBe('DELIVERY#DEAD')
    expect(keys.deliveriesByStatus('delivered')).toBe('DELIVERY#DELIVERED')
  })
})

describe('truncate', () => {
  it('leaves a short message alone', () => {
    expect(truncate('short')).toBe('short')
  })

  it('cuts a long message and says it did', () => {
    const cut = truncate('x'.repeat(1000))
    expect(cut).toHaveLength(MAX_ERROR_CHARACTERS + 3)
    expect(cut.endsWith('...')).toBe(true)
  })

  it('takes its own limit', () => {
    expect(truncate('abcdef', 3)).toBe('abc...')
  })
})

describe('TERMINAL', () => {
  it('holds the statuses nothing retries', () => {
    expect([...TERMINAL].sort()).toEqual(['dead', 'delivered'])
  })
})
