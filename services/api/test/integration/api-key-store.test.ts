import { hashApiKey } from '@blockwarden/core'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authorize } from '../../src/authorizer.js'
import { createStore, type ApiStore } from '../../src/store.js'

let dynamo: Dynamo
let table: string
let store: ApiStore
const secret = new TextEncoder().encode('s'.repeat(48))
const now = 1_770_000_000_000

beforeAll(async () => {
  dynamo = await startDynamo()
  table = await dynamo.newTable()
  store = createStore({ doc: dynamo.doc, table })
}, 180_000)

afterAll(async () => {
  await dynamo?.stop()
})

// exactly the attributes infra/terraform/modules/relayer/signers.tf's aws_dynamodb_table_item.api_key
// writes: PK, SK, signerIds, label - no hash attribute, no createdAt
async function putTerraformApiKey(hash: string, signerIds: string[], label: string): Promise<void> {
  await dynamo.doc.send(
    new PutCommand({ TableName: table, Item: { PK: `APIKEY#${hash}`, SK: 'META', signerIds, label } }),
  )
}

describe('getApiKey against a Terraform-shaped row', () => {
  it('reads back the signer allowlist and label of a row that carries no hash attribute', async () => {
    const hash = hashApiKey('bw_terraform-shaped-key')
    await putTerraformApiKey(hash, ['billing', 'sweeper'], 'billwarden')
    expect(await store.getApiKey(hash)).toEqual({ hash, signerIds: ['billing', 'sweeper'], label: 'billwarden' })
  })

  it('returns undefined for a hash that was never stored', async () => {
    expect(await store.getApiKey(hashApiKey('bw_never-issued'))).toBeUndefined()
  })

  it('refuses a row with a non-string signerIds element and logs the label, rather than passing it through', async () => {
    const hash = hashApiKey('bw_malformed-key')
    await putTerraformApiKey(hash, ['billing'], 'malformed-label')
    // a real Terraform typo can't produce a number in a list of strings, but the type on the wire is
    // whatever the table actually holds, not what the module intends to write
    await dynamo.doc.send(
      new PutCommand({
        TableName: table,
        Item: { PK: `APIKEY#${hash}`, SK: 'META', signerIds: ['billing', 7], label: 'malformed-label' },
      }),
    )
    const calls: [string, Record<string, unknown> | undefined, string | undefined][] = []
    const logged = createStore({
      doc: dynamo.doc,
      table,
      log: (message, data, level) => calls.push([message, data, level]),
    })
    expect(await logged.getApiKey(hash)).toBeUndefined()
    expect(calls).toEqual([[expect.any(String), { label: 'malformed-label' }, 'error']])
  })

  it("admits a real bearer key end to end, with the caller carrying the row's signer allowlist", async () => {
    const rawKey = 'bw_end-to-end-key'
    const hash = hashApiKey(rawKey)
    await putTerraformApiKey(hash, ['demo-signer'], 'ci-key')
    const result = await authorize({ secret, now: () => now, store, hash: hashApiKey }, {
      version: '2.0',
      routeKey: 'GET /v1/rules',
      headers: { authorization: `Bearer ${rawKey}` },
    } as never)
    expect(result.isAuthorized).toBe(true)
    expect(JSON.parse((result.context as { caller: string }).caller)).toEqual({
      kind: 'apiKey',
      hash,
      signerIds: ['demo-signer'],
      label: 'ci-key',
    })
  })
})
