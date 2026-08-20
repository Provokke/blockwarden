import { describe, expect, it } from 'vitest'
import { toStorable } from '../src/storable.js'

describe('toStorable', () => {
  it('turns bigints into decimal strings at any depth and leaves the rest alone', () => {
    const input = { value: 2n ** 200n, nested: { ids: [1n, 2n], ok: true, name: 'x', count: 3 }, none: null }
    expect(toStorable(input)).toEqual({
      value: (2n ** 200n).toString(),
      nested: { ids: ['1', '2'], ok: true, name: 'x', count: 3 },
      none: null,
    })
  })
})
