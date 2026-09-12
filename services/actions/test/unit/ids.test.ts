import { describe, expect, it } from 'vitest'
import { actionId, canonicalJson, deliveryId } from '../../src/ids.js'

describe('canonicalJson', () => {
  it('orders object keys so a reordered action hashes the same', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }))
  })

  it('keeps array order, because an array is data and not a set', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]')
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]))
  })

  it('orders nested keys too', () => {
    expect(canonicalJson({ z: { d: 1, c: [{ b: 1, a: 2 }] } })).toBe('{"z":{"c":[{"a":2,"b":1}],"d":1}}')
  })

  it('drops a property whose value is undefined, as JSON does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('keeps null, which is a value', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}')
  })
})

describe('actionId', () => {
  it('is a_ and sixteen lowercase hex characters', () => {
    expect(actionId({ type: 'webhook', url: 'https://example.com/hook' })).toMatch(/^a_[0-9a-f]{16}$/)
  })

  it('does not change when the action is written with its keys in another order', () => {
    expect(actionId({ type: 'webhook', url: 'https://example.com/hook' })).toBe(
      actionId({ url: 'https://example.com/hook', type: 'webhook' }),
    )
  })

  it('changes when any value changes', () => {
    expect(actionId({ type: 'webhook', url: 'https://example.com/a' })).not.toBe(
      actionId({ type: 'webhook', url: 'https://example.com/b' }),
    )
  })
})

describe('deliveryId', () => {
  it('is dlv_ and thirty-two lowercase hex characters', () => {
    expect(deliveryId('TX#abc', 'DELIVERY#a_0123456789abcdef#tx.mined#3')).toMatch(/^dlv_[0-9a-f]{32}$/)
  })

  it('differs for two history entries of the same transaction and status', () => {
    const first = deliveryId('TX#abc', 'DELIVERY#a_0123456789abcdef#tx.mined#3')
    const second = deliveryId('TX#abc', 'DELIVERY#a_0123456789abcdef#tx.mined#7')
    expect(first).not.toBe(second)
  })

  it('cannot be confused between a subject ending in # and a sort key starting with one', () => {
    expect(deliveryId('TX#a', 'b#c')).not.toBe(deliveryId('TX#a\nb', 'c'))
  })
})
