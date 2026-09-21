import { describe, expect, it } from 'vitest'
import { jsonSafe, readRecord } from '../../src/stream.js'
import { matchRow, streamRecord } from '../helpers/images.js'

describe('readRecord', () => {
  it('unmarshals both images and the key', () => {
    const before = matchRow({ status: 'provisional' })
    const after = matchRow({ status: 'final' })
    const change = readRecord(
      streamRecord('MODIFY', { PK: before.PK as string, SK: 'META' }, { oldImage: before, newImage: after }),
    )
    expect(change?.eventName).toBe('MODIFY')
    expect(change?.pk).toBe(before.PK)
    expect(change?.sk).toBe('META')
    expect(change?.oldImage?.status).toBe('provisional')
    expect(change?.newImage?.status).toBe('final')
    expect(change?.newImage?.blockNumber).toBe(12_345_678)
  })

  it('reads an INSERT with no old image and a REMOVE with no new one', () => {
    const row = matchRow()
    expect(
      readRecord(streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row }))?.oldImage,
    ).toBeUndefined()
    expect(
      readRecord(streamRecord('REMOVE', { PK: row.PK as string, SK: 'META' }, { oldImage: row }))?.newImage,
    ).toBeUndefined()
  })

  it('ignores a record with no key or no event name, rather than throwing', () => {
    expect(readRecord({ eventSource: 'aws:dynamodb' })).toBeUndefined()
    expect(readRecord({ eventName: 'INSERT', dynamodb: {} })).toBeUndefined()
  })
})

describe('jsonSafe', () => {
  it('turns a bigint into a decimal string, because JSON.stringify throws on one', () => {
    // unmarshall gives back a bigint for any N above Number.MAX_SAFE_INTEGER
    expect(jsonSafe({ n: 99999999999999999999999n })).toEqual({ n: '99999999999999999999999' })
    expect(() => JSON.stringify(jsonSafe({ n: 1n }))).not.toThrow()
  })

  it('turns a Set into an array, because JSON.stringify writes one as {}', () => {
    expect(jsonSafe({ s: new Set(['a', 'b']) })).toEqual({ s: ['a', 'b'] })
  })

  it('walks arrays and nested objects, and turns a number into a decimal string', () => {
    // viem decodes an integer of 48 bits or fewer as a JS number, and the schema publishes every integer as a string
    expect(jsonSafe({ a: [{ b: 1n }], c: 'x', d: true, e: null, tick: -201_234 })).toEqual({
      a: [{ b: '1' }],
      c: 'x',
      d: true,
      e: null,
      tick: '-201234',
    })
  })

  it('throws on a number that is not an integer, rather than sending a rounded one', () => {
    expect(() => jsonSafe({ fee: 0.5 })).toThrow(/not an integer/)
  })
})
