import { describe, expect, it } from 'vitest'
import { changesFor } from '../../src/events.js'
import { readRecord } from '../../src/stream.js'
import { matchRow, streamRecord, txRow } from '../helpers/images.js'

const changes = (record: Parameters<typeof readRecord>[0]) => changesFor(readRecord(record)!)

describe('matches', () => {
  const pk = matchRow().PK as string

  it('a provisional match created is one match.provisional', () => {
    const row = matchRow({ status: 'provisional' })
    expect(changes(streamRecord('INSERT', { PK: pk, SK: 'META' }, { newImage: row }))).toEqual([
      expect.objectContaining({ kind: 'match', subject: pk, event: 'match.provisional', seq: 0 }),
    ])
  })

  it('a final match created straight away is one match.final', () => {
    const row = matchRow({ status: 'final', finalizedAt: '2026-09-20T10:19:00.000Z' })
    expect(changes(streamRecord('INSERT', { PK: pk, SK: 'META' }, { newImage: row }))).toEqual([
      expect.objectContaining({ event: 'match.final' }),
    ])
  })

  it('a provisional match upgraded is one match.final', () => {
    const before = matchRow({ status: 'provisional' })
    const after = matchRow({ status: 'final', finalizedAt: 'x' })
    expect(changes(streamRecord('MODIFY', { PK: pk, SK: 'META' }, { oldImage: before, newImage: after }))).toEqual([
      expect.objectContaining({ event: 'match.final' }),
    ])
  })

  it('a provisional match dropped is one match.dropped', () => {
    const before = matchRow({ status: 'provisional' })
    const after = matchRow({ status: 'dropped' })
    expect(changes(streamRecord('MODIFY', { PK: pk, SK: 'META' }, { oldImage: before, newImage: after }))).toEqual([
      expect.objectContaining({ event: 'match.dropped' }),
    ])
  })

  it('carries the row, matchKey and ruleId onto the change', () => {
    const row = matchRow({ status: 'provisional', matchKey: 'mk-9', ruleId: 'rule-9' })
    expect(changes(streamRecord('INSERT', { PK: pk, SK: 'META' }, { newImage: row }))).toEqual([
      expect.objectContaining({ row, matchKey: 'mk-9', ruleId: 'rule-9' }),
    ])
  })

  it('a rewrite that does not change the status is nothing', () => {
    const row = matchRow({ status: 'final' })
    expect(
      changes(streamRecord('MODIFY', { PK: pk, SK: 'META' }, { oldImage: row, newImage: { ...row, expiresAt: 1 } })),
    ).toEqual([])
  })

  it('a deletion is nothing, so a TTL expiry does not send a webhook', () => {
    expect(
      changes(streamRecord('REMOVE', { PK: pk, SK: 'META' }, { oldImage: matchRow({ status: 'final' }) })),
    ).toEqual([])
  })
})

describe('transactions', () => {
  it('a created transaction is one event per history entry', () => {
    const row = txRow()
    expect(changes(streamRecord('INSERT', { PK: 'TX#tx-1', SK: 'META' }, { newImage: row }))).toEqual([
      expect.objectContaining({ kind: 'tx', subject: 'TX#tx-1', event: 'tx.queued', seq: 0 }),
    ])
  })

  it('a status change is one event for the entry it added', () => {
    const before = txRow()
    const after = txRow({
      status: 'submitted',
      history: [
        { status: 'queued', at: 't0' },
        { status: 'submitted', at: 't1' },
      ],
    })
    expect(
      changes(streamRecord('MODIFY', { PK: 'TX#tx-1', SK: 'META' }, { oldImage: before, newImage: after })),
    ).toEqual([expect.objectContaining({ event: 'tx.submitted', seq: 1 })])
  })

  it('two entries added at once are two events', () => {
    const before = txRow()
    const after = txRow({
      status: 'confirmed',
      history: [
        { status: 'queued', at: 't0' },
        { status: 'mined', at: 't1' },
        { status: 'confirmed', at: 't2' },
      ],
    })
    const result = changes(streamRecord('MODIFY', { PK: 'TX#tx-1', SK: 'META' }, { oldImage: before, newImage: after }))
    expect(result.map((c) => [c.event, c.seq])).toEqual([
      ['tx.mined', 1],
      ['tx.confirmed', 2],
    ])
  })

  it('a write that adds no history entry is nothing', () => {
    const row = txRow()
    expect(
      changes(
        streamRecord('MODIFY', { PK: 'TX#tx-1', SK: 'META' }, { oldImage: row, newImage: { ...row, version: 1 } }),
      ),
    ).toEqual([])
  })

  it('counts from historyBase, so a reorg that mines twice is two deliveries', () => {
    const before = txRow({ historyBase: 70, history: [{ status: 'submitted', at: 't70' }] })
    const after = txRow({
      status: 'mined',
      historyBase: 70,
      history: [
        { status: 'submitted', at: 't70' },
        { status: 'mined', at: 't71' },
      ],
    })
    expect(
      changes(streamRecord('MODIFY', { PK: 'TX#tx-1', SK: 'META' }, { oldImage: before, newImage: after })),
    ).toEqual([expect.objectContaining({ event: 'tx.mined', seq: 71 })])
  })

  it('a deletion is nothing', () => {
    expect(changes(streamRecord('REMOVE', { PK: 'TX#tx-1', SK: 'META' }, { oldImage: txRow() }))).toEqual([])
  })
})

describe('everything else on the stream', () => {
  it('ignores a delivery, which shares its partition key with its match', () => {
    const row = { PK: 'MATCH#0xabc', SK: 'DELIVERY#a_1#match.final#0000', status: 'delivered' }
    expect(changes(streamRecord('INSERT', { PK: row.PK, SK: row.SK }, { newImage: row }))).toEqual([])
  })

  it('ignores a cursor, a lease, a rule, a signer, a nonce and an idempotency record', () => {
    for (const [PK, SK] of [
      ['CHAIN#1', 'CURSOR'],
      ['CHAIN#1', 'LEASE'],
      ['RULE#r1', 'META'],
      ['SIGNER#s1', 'META'],
      ['SIGNER#s1', 'NONCE#1'],
      ['IDEMP#abc#k', 'META'],
      ['APIKEY#abc', 'META'],
    ]) {
      expect(changes(streamRecord('INSERT', { PK: PK!, SK: SK! }, { newImage: { PK, SK } })), `${PK} ${SK}`).toEqual([])
    }
  })

  it('ignores an image that is missing the fields it would need', () => {
    expect(
      changes(streamRecord('INSERT', { PK: 'TX#tx-1', SK: 'META' }, { newImage: { PK: 'TX#tx-1', SK: 'META' } })),
    ).toEqual([])
    expect(
      changes(streamRecord('INSERT', { PK: 'MATCH#0x1', SK: 'META' }, { newImage: { PK: 'MATCH#0x1', SK: 'META' } })),
    ).toEqual([])
  })
})
