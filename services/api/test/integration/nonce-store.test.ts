import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NONCE_SECONDS, createStore, type ApiStore } from '../../src/store.js'

let dynamo: Dynamo
let store: ApiStore
let table: string
const now = 1_770_000_000_000

beforeAll(async () => {
  dynamo = await startDynamo()
  table = await dynamo.newTable()
  store = createStore({ doc: dynamo.doc, table })
}, 180_000)

afterAll(async () => {
  await dynamo?.stop()
})

describe('the nonce store', () => {
  it('accepts a nonce once and refuses the second use', async () => {
    await store.put('nonce-one', now)
    expect(await store.consume('nonce-one', now)).toBe(true)
    expect(await store.consume('nonce-one', now)).toBe(false)
  })

  it('refuses a nonce that was never issued', async () => {
    expect(await store.consume('never-issued', now)).toBe(false)
  })

  it('refuses a nonce past its window even though the row is still there', async () => {
    await store.put('nonce-stale', now)
    expect(await store.consume('nonce-stale', now + NONCE_SECONDS * 1000 + 1)).toBe(false)
  })

  it('consumes a nonce one millisecond inside its window', async () => {
    await store.put('nonce-fresh', now)
    expect(await store.consume('nonce-fresh', now + NONCE_SECONDS * 1000 - 1)).toBe(true)
  })

  it('deletes an expired nonce as it refuses it, so a replay cannot wait for a slow sweep', async () => {
    await store.put('nonce-burn', now)
    expect(await store.consume('nonce-burn', now + NONCE_SECONDS * 1000 + 1)).toBe(false)
    // the row is gone, so even a caller who fixes their clock cannot use it
    expect(await store.consume('nonce-burn', now)).toBe(false)
  })

  it('writes a ttl attribute in seconds, which is the unit DynamoDB reads', async () => {
    await store.put('nonce-ttl', now)
    const row = await dynamo.doc.send(new GetCommand({ TableName: table, Key: { PK: 'SIWE#nonce-ttl', SK: 'META' } }))
    // milliseconds here would set an expiry 50,000 years out, and nothing anywhere would say so
    expect(row.Item?.ttl).toBe(Math.ceil((now + NONCE_SECONDS * 1000) / 1000))
  })
})
