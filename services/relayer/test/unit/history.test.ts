import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { historyCount, historyEntries, MAX_HISTORY, withStatus, type TxRecord } from '../../src/records.js'
import { txRecord } from '../helpers/fixtures.js'

const STATUSES = ['queued', 'submitted', 'mined', 'confirmed'] as const

describe('withStatus', () => {
  it('appends one entry per change and none for a repeat', () => {
    let tx = txRecord({ status: 'queued', history: [{ status: 'queued', at: 't0' }] })
    tx = withStatus(tx, 'submitted', 't1')
    tx = withStatus(tx, 'submitted', 't2')
    expect(tx.history).toEqual([
      { status: 'queued', at: 't0' },
      { status: 'submitted', at: 't1' },
    ])
    expect(tx.historyBase).toBeUndefined()
  })

  it('keeps the newest entries and counts the ones it dropped', () => {
    let tx = txRecord({ status: 'queued', history: [{ status: 'queued', at: 't0' }] })
    for (let i = 1; i <= MAX_HISTORY + 10; i++) tx = withStatus(tx, i % 2 === 0 ? 'mined' : 'submitted', `t${i}`)
    expect(tx.history).toHaveLength(MAX_HISTORY)
    expect(tx.historyBase).toBe(11)
    expect(tx.history[0]).toEqual({ status: 'submitted', at: 't11' })
  })
})

describe('historyEntries', () => {
  it('numbers an untruncated history from zero', () => {
    const tx = txRecord({
      history: [
        { status: 'queued', at: 't0' },
        { status: 'submitted', at: 't1' },
      ],
    })
    expect(historyEntries(tx)).toEqual([
      { seq: 0, status: 'queued', at: 't0' },
      { seq: 1, status: 'submitted', at: 't1' },
    ])
    expect(historyCount(tx)).toBe(2)
  })

  it('carries on from the base after a truncation', () => {
    const tx = txRecord({ historyBase: 11, history: [{ status: 'mined', at: 'tA' }] })
    expect(historyEntries(tx)).toEqual([{ seq: 11, status: 'mined', at: 'tA' }])
    expect(historyCount(tx)).toBe(12)
  })
})

describe('sequence numbers', () => {
  it('never repeats one, however many times the status flips', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...STATUSES), { minLength: 1, maxLength: 300 }), (changes) => {
        let tx: TxRecord = txRecord({ status: 'queued', history: [{ status: 'queued', at: 't0' }] })
        const seen: number[] = [0]
        for (const [i, status] of changes.entries()) {
          const before = historyCount(tx)
          tx = withStatus(tx, status, `t${i + 1}`)
          const after = historyCount(tx)
          // one change is one new sequence number, and a repeat is not a change
          expect(after - before).toBeLessThanOrEqual(1)
          if (after > before) seen.push(after - 1)
          expect(tx.history.length).toBeLessThanOrEqual(MAX_HISTORY)
        }
        expect(new Set(seen).size).toBe(seen.length)
        expect([...seen].sort((a, b) => a - b)).toEqual(seen)
        // every entry still on the item reports the sequence number it was given
        for (const entry of historyEntries(tx)) expect(seen).toContain(entry.seq)
      }),
      { numRuns: 200 },
    )
  })
})
