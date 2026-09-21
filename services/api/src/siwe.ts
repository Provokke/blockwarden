import { generateSiweNonce } from 'viem/siwe'
import type { NonceStore } from './store.js'

export { NONCE_SECONDS } from './store.js'

export async function issueNonce(store: NonceStore, nowMs: number): Promise<string> {
  const nonce = generateSiweNonce()
  await store.put(nonce, nowMs)
  return nonce
}
