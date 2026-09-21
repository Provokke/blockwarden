import { describe, expect, it } from 'vitest'
import { deliveryId } from '../../src/ids.js'
import { DUE_SHARDS, keys } from '../../src/keys.js'
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

  it('shards the due partition and has one partition per listed status', () => {
    expect(keys.dueDeliveries(2)).toBe('DELIVERY#DUE#2')
    expect(keys.deliveriesByStatus('dead')).toBe('DELIVERY#DEAD')
    expect(keys.deliveriesByStatus('delivered')).toBe('DELIVERY#DELIVERED')
  })

  it('sends a delivery to the same shard every time and spreads the ids over all of them', () => {
    const ids = Array.from({ length: 200 }, (_, i) => deliveryId(keys.matchSubject(`0x${i}`), 'DELIVERY#a#e#0000'))
    expect(ids.map(keys.dueShard)).toEqual(ids.map(keys.dueShard))
    expect(new Set(ids.map(keys.dueShard))).toEqual(new Set([0, 1, 2, 3]))
    expect(ids.every((id) => keys.dueShard(id) < DUE_SHARDS)).toBe(true)
  })

  it('refuses a seq that would not fit or sort in four digits', () => {
    const subject = keys.txSubject('t1')
    expect(() => keys.delivery(subject, 'a_00112233aabbccdd', 'tx.mined', 10000)).toThrow(/seq/)
    expect(() => keys.delivery(subject, 'a_00112233aabbccdd', 'tx.mined', -1)).toThrow(/seq/)
    expect(() => keys.delivery(subject, 'a_00112233aabbccdd', 'tx.mined', 1.5)).toThrow(/seq/)
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

  it('cuts a whole code point instead of splitting a surrogate pair', () => {
    // the emoji is two UTF-16 code units; a plain slice(0, 5) would land on the high surrogate
    const text = `aaaa${String.fromCodePoint(0x1f600)}bbbb`
    const cut = truncate(text, 5)
    expect(cut).toBe('aaaa...')
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
})

describe('TERMINAL', () => {
  it('holds the statuses nothing retries', () => {
    expect([...TERMINAL].sort()).toEqual(['dead', 'delivered'])
  })
})
