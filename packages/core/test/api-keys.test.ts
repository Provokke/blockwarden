import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hashApiKey } from '../src/api-keys.js'

describe('hashApiKey', () => {
  it('is the sha256 hex digest of the key, unchanged from the relayer', () => {
    const key = 'bw_live_example_key'
    expect(hashApiKey(key)).toBe(createHash('sha256').update(key).digest('hex'))
  })

  it('is 64 hex characters', () => {
    expect(hashApiKey('anything')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('separates two keys that differ by one character', () => {
    expect(hashApiKey('key-a')).not.toBe(hashApiKey('key-b'))
  })
})
