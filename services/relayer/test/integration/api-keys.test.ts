import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApiKey } from '../../src/api-keys.js'
import { RelayerStore } from '../../src/store.js'
import { hashApiKey } from '../../src/submit.js'
import { signerRecord } from '../helpers/fixtures.js'

describe('createApiKey', () => {
  let dynamo: Dynamo
  let store: RelayerStore

  beforeAll(async () => {
    dynamo = await startDynamo()
    store = new RelayerStore(dynamo.doc, await dynamo.newTable())
    await store.putSigner(signerRecord())
  })

  afterAll(async () => {
    await dynamo?.stop()
  })

  it('stores only the hash of a random key scoped to existing signers', async () => {
    const now = new Date('2026-09-17T00:00:00.000Z')
    const first = await createApiKey(store, { signerIds: ['billing'], label: 'billwarden', now })
    const second = await createApiKey(store, { signerIds: ['billing'], label: 'billwarden', now })
    expect(first).toMatch(/^bw_[A-Za-z0-9_-]{43}$/)
    expect(second).not.toBe(first)
    expect(await store.getApiKey(hashApiKey(first))).toEqual({
      hash: hashApiKey(first),
      signerIds: ['billing'],
      label: 'billwarden',
      createdAt: now.toISOString(),
    })
  })

  it('refuses an unknown signer or none at all', async () => {
    const now = new Date()
    await expect(createApiKey(store, { signerIds: ['ghost'], label: 'x', now })).rejects.toThrow(/ghost/)
    await expect(createApiKey(store, { signerIds: [], label: 'x', now })).rejects.toThrow(/at least one/)
  })
})
