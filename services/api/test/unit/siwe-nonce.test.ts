import { describe, expect, it } from 'vitest'
import { NONCE_SECONDS, issueNonce } from '../../src/siwe.js'
import type { NonceStore } from '../../src/store.js'

function fakeStore() {
  const rows = new Map<string, number>()
  const store: NonceStore = {
    async put(nonce, nowMs) {
      rows.set(nonce, nowMs + NONCE_SECONDS * 1000)
    },
    async consume(nonce, nowMs) {
      const expiresAt = rows.get(nonce)
      if (expiresAt === undefined) return false
      rows.delete(nonce)
      return nowMs < expiresAt
    },
  }
  return { store, rows }
}

describe('issueNonce', () => {
  it('stores what it returns', async () => {
    const { store, rows } = fakeStore()
    const nonce = await issueNonce(store, 1_770_000_000_000)
    expect(rows.has(nonce)).toBe(true)
  })

  it('issues a nonce of at least 8 alphanumeric characters, as EIP-4361 requires', async () => {
    const { store } = fakeStore()
    const nonce = await issueNonce(store, 1_770_000_000_000)
    expect(nonce).toMatch(/^[a-zA-Z0-9]{8,}$/)
  })

  it('never issues the same nonce twice in a thousand draws', async () => {
    const { store } = fakeStore()
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(await issueNonce(store, 1_770_000_000_000))
    expect(seen.size).toBe(1000)
  })

  it('expires in five minutes', () => {
    expect(NONCE_SECONDS).toBe(300)
  })
})
