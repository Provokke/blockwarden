import { randomBytes } from 'node:crypto'
import type { RelayerStore } from './store.js'
import { hashApiKey } from './submit.js'

// Only the SHA-256 of the key is stored, so the returned key is the only copy.
export async function createApiKey(
  store: RelayerStore,
  options: { signerIds: string[]; label: string; now: Date },
): Promise<string> {
  if (options.signerIds.length === 0) throw new Error('an API key needs at least one signer')
  for (const signerId of options.signerIds) {
    if (!(await store.getSigner(signerId))) throw new Error(`no signer has the id ${signerId}`)
  }
  const apiKey = `bw_${randomBytes(32).toString('base64url')}`
  await store.putApiKey({
    hash: hashApiKey(apiKey),
    signerIds: options.signerIds,
    label: options.label,
    createdAt: options.now.toISOString(),
  })
  return apiKey
}
