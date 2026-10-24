import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { GSI2 } from '@blockwarden/dynamo'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import type { TxRecord } from '../../../relayer/src/records.js'
import { RelayerStore, type SpendReservation } from '../../../relayer/src/store.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Caller } from '../../src/caller.js'
import { decodeCursor, encodeCursor } from '../../src/http.js'
import { handleGetTx, handleListSigners, handleListTxs, type RelayerDeps } from '../../src/relayer-routes.js'
import { createStore, type ApiStore } from '../../src/store.js'

let dynamo: Dynamo
let table: string
let apiStore: ApiStore
let relayerStore: RelayerStore

const CHAIN = 84532
const OTHER_CHAIN = 421614
const session: Caller = { kind: 'session', address: '0x1111111111111111111111111111111111111111' }
const demoKey: Caller = { kind: 'apiKey', hash: 'a'.repeat(64), signerIds: ['demo'], label: 'ci' }

const deps = (): RelayerDeps => ({ store: apiStore })

// narrowed to the real event type rather than to `never`, same helper as rules-store.test.ts's apiEvent
function apiEvent(over: Partial<APIGatewayProxyEventV2>): APIGatewayProxyEventV2 {
  return { version: '2.0', headers: {}, ...over } as APIGatewayProxyEventV2
}

beforeAll(async () => {
  dynamo = await startDynamo()
  table = await dynamo.newTable()
  apiStore = createStore({ doc: dynamo.doc, table })
  relayerStore = new RelayerStore(dynamo.doc, table)
}, 180_000)

afterAll(async () => {
  await dynamo?.stop()
})

// exactly the attributes infra/terraform/modules/relayer/signers.tf's aws_dynamodb_table_item.signer writes,
// including the sparse GSI1 entry that lists signers: PK, SK, GSI1PK, GSI1SK, signerId, keyId, chainIds,
// webhooks, policy - no address attribute (Terraform has no keccak256 to compute one) and no
// webhookSecretParameter for a signer that does not configure one. Written by hand, not through
// RelayerStore.putSigner, because that method does not set GSI1PK/GSI1SK, so only a row shaped like
// Terraform's shows whether the route can list what a deployment really holds.
async function putTerraformSigner(id: string, chainIds: number[]): Promise<void> {
  await dynamo.doc.send(
    new PutCommand({
      TableName: table,
      Item: {
        PK: `SIGNER#${id}`,
        SK: 'META',
        GSI1PK: 'SIGNER#ALL',
        GSI1SK: id,
        signerId: id,
        keyId: `arn:aws:kms:ap-southeast-2:111111111111:key/${id}`,
        chainIds,
        webhooks: [],
        policy: {
          allowedTo: [{ address: '0x000000000000000000000000000000000000dEaD', selectors: ['0x'] }],
          maxGasLimit: 500000,
          maxFeePerGas: '5000000000',
          maxPriorityFeePerGas: '2000000000',
          dailySpendCapWei: '50000000000000000',
        },
      },
    }),
  )
}

const SPEND: SpendReservation = { day: '2026-09-21', costGwei: 0, capGwei: 1_000_000 }

function baseTx(overrides: Partial<TxRecord> = {}): TxRecord {
  const at = overrides.createdAt ?? '2026-09-21T00:00:00.000Z'
  return {
    txId: `tx-${Math.random().toString(16).slice(2)}`,
    kind: 'relay',
    signerId: 'demo',
    chainId: CHAIN,
    from: `0x${'a'.repeat(40)}`,
    to: `0x${'b'.repeat(40)}`,
    data: '0x',
    value: '0',
    gasLimit: '60000',
    status: 'queued',
    attempts: [],
    idempotencyKey: `key-${Math.random().toString(16).slice(2)}`,
    apiKeyHash: 'a'.repeat(64),
    enqueuedAt: Date.parse(at),
    enqueues: 1,
    history: [{ status: 'queued', at }],
    createdAt: at,
    updatedAt: at,
    version: 1,
    ...overrides,
  }
}

// seeds a transaction through the relayer's own store, the only writer real infrastructure ever uses - never
// by poking a status onto a row by hand (same reasoning as deliveries-store.test.ts's deadDelivery)
async function createPendingTx(overrides: Partial<TxRecord> = {}): Promise<TxRecord> {
  const tx = baseTx(overrides)
  const result = await relayerStore.createTx(tx, SPEND, Date.parse(tx.createdAt))
  if (!result.created) throw new Error(`could not create ${tx.txId}: ${result.reason}`)
  return tx
}

async function createConfirmedTx(overrides: Partial<TxRecord> = {}): Promise<TxRecord> {
  const created = await createPendingTx(overrides)
  return relayerStore.saveTx(
    {
      ...created,
      status: 'confirmed',
      mined: {
        hash: `0x${'c'.repeat(64)}`,
        blockNumber: 19_000_000,
        blockHash: `0x${'d'.repeat(64)}`,
        status: 'success',
      },
    },
    '2026-09-21T00:05:00.000Z',
  )
}

// the listing routes work out which chains are relayed from the signer rows, so every describe that lists
// needs them; a put of the same key just overwrites, so each describe can seed them for itself
async function seedSigners(): Promise<void> {
  await putTerraformSigner('demo', [CHAIN, OTHER_CHAIN])
  await putTerraformSigner('treasury', [OTHER_CHAIN])
}

describe('signers through the API, over a row shaped exactly like Terraform writes it', () => {
  beforeAll(seedSigners)

  it('a session sees every signer; an API key sees only the ones it may use', async () => {
    const sessionResult = await handleListSigners(deps(), session, apiEvent({ routeKey: 'GET /v1/relayer/signers' }))
    const sessionBody = sessionResult.body as { signers: { signerId: string; address?: string }[] }
    expect(sessionBody.signers.map((s) => s.signerId).sort()).toEqual(['demo', 'treasury'])
    // Terraform never writes an address attribute, so a row that does not carry one must not grow one here
    expect(sessionBody.signers.every((s) => s.address === undefined)).toBe(true)

    const keyResult = await handleListSigners(deps(), demoKey, apiEvent({ routeKey: 'GET /v1/relayer/signers' }))
    const keyBody = keyResult.body as { signers: { signerId: string }[] }
    expect(keyBody.signers.map((s) => s.signerId)).toEqual(['demo'])
  })
})

describe('a transaction through the API, over rows the relayer store wrote', () => {
  it('a session reads a confirmed transaction, with blockNumber and value as strings', async () => {
    const tx = await createConfirmedTx({ signerId: 'demo', value: '2500000000000000000' })
    const result = await handleGetTx(
      deps(),
      session,
      apiEvent({ routeKey: 'GET /v1/relayer/txs/{txId}', pathParameters: { txId: tx.txId } }),
    )
    expect(result.status).toBe(200)
    const body = result.body as { blockNumber: string; value: string; hash: string }
    expect(body.blockNumber).toBe('19000000')
    expect(typeof body.blockNumber).toBe('string')
    expect(body.value).toBe('2500000000000000000')
    expect(body.hash).toBe(`0x${'c'.repeat(64)}`)
  })

  it('an API key reads its own signer transaction but the other signer transaction reads as missing', async () => {
    const demoTx = await createConfirmedTx({ signerId: 'demo' })
    const treasuryTx = await createConfirmedTx({ signerId: 'treasury' })

    const own = await handleGetTx(
      deps(),
      demoKey,
      apiEvent({ routeKey: 'GET /v1/relayer/txs/{txId}', pathParameters: { txId: demoTx.txId } }),
    )
    expect(own.status).toBe(200)

    const other = await handleGetTx(
      deps(),
      demoKey,
      apiEvent({ routeKey: 'GET /v1/relayer/txs/{txId}', pathParameters: { txId: treasuryTx.txId } }),
    )
    expect(other.status).toBe(404)
    expect((other.body as { error: { code: string } }).error.code).toBe('tx_not_found')
  })

  it('getTx on an id that was never stored returns 404, not a throw', async () => {
    const result = await handleGetTx(
      deps(),
      session,
      apiEvent({ routeKey: 'GET /v1/relayer/txs/{txId}', pathParameters: { txId: 'tx-does-not-exist' } }),
    )
    expect(result.status).toBe(404)
  })
})

describe('listing pending transactions through the API', () => {
  beforeAll(seedSigners)

  it('a session sees every signer pending on the chain; an API key sees only its own, filtered after paging', async () => {
    const demoPending = await createPendingTx({
      signerId: 'demo',
      chainId: CHAIN,
      createdAt: '2026-09-21T01:00:00.000Z',
    })
    const treasuryPending = await createPendingTx({
      signerId: 'treasury',
      chainId: CHAIN,
      createdAt: '2026-09-21T01:00:01.000Z',
    })

    const sessionResult = await handleListTxs(
      deps(),
      session,
      apiEvent({
        routeKey: 'GET /v1/relayer/txs',
        queryStringParameters: { status: 'pending', chainId: String(CHAIN) },
      }),
    )
    const sessionTxIds = (sessionResult.body as { txs: { txId: string }[] }).txs.map((t) => t.txId)
    expect(sessionTxIds).toEqual(expect.arrayContaining([demoPending.txId, treasuryPending.txId]))

    const keyResult = await handleListTxs(
      deps(),
      demoKey,
      apiEvent({
        routeKey: 'GET /v1/relayer/txs',
        queryStringParameters: { status: 'pending', chainId: String(CHAIN) },
      }),
    )
    const keyTxIds = (keyResult.body as { txs: { txId: string }[] }).txs.map((t) => t.txId)
    expect(keyTxIds).toContain(demoPending.txId)
    expect(keyTxIds).not.toContain(treasuryPending.txId)
  })

  it('pages with a real cursor whose key shape matches what this route accepts back, oldest first', async () => {
    const chain = OTHER_CHAIN
    const first = await createPendingTx({ signerId: 'demo', chainId: chain, createdAt: '2026-09-21T02:00:00.000Z' })
    const second = await createPendingTx({ signerId: 'demo', chainId: chain, createdAt: '2026-09-21T02:00:01.000Z' })
    const third = await createPendingTx({ signerId: 'demo', chainId: chain, createdAt: '2026-09-21T02:00:02.000Z' })

    const page1 = await handleListTxs(
      deps(),
      session,
      apiEvent({
        routeKey: 'GET /v1/relayer/txs',
        queryStringParameters: { status: 'pending', chainId: String(chain), limit: '2' },
      }),
    )
    const body1 = page1.body as { txs: { txId: string }[]; cursor?: string }
    expect(body1.txs.map((t) => t.txId)).toEqual([first.txId, second.txId])
    expect(body1.cursor).toBeDefined()

    // what a real LastEvaluatedKey for this GSI2 query actually contains, and
    // exactly what relayer-routes.ts's isTxListKey checks a caller-supplied cursor against
    const decoded = decodeCursor(body1.cursor!) as { chainId: number; key: Record<string, unknown> }
    expect(decoded.chainId).toBe(chain)
    expect(Object.keys(decoded.key).sort()).toEqual(['GSI2PK', 'GSI2SK', 'PK', 'SK'])
    expect(typeof decoded.key.PK).toBe('string')
    expect(typeof decoded.key.SK).toBe('string')
    expect(typeof decoded.key.GSI2PK).toBe('string')
    expect(typeof decoded.key.GSI2SK).toBe('number')

    const page2 = await handleListTxs(
      deps(),
      session,
      apiEvent({
        routeKey: 'GET /v1/relayer/txs',
        queryStringParameters: { status: 'pending', chainId: String(chain), limit: '2', cursor: body1.cursor! },
      }),
    )
    const body2 = page2.body as { txs: { txId: string }[]; cursor?: string }
    expect(body2.txs.map((t) => t.txId)).toEqual([third.txId])
    expect(body2.cursor).toBeUndefined()
  })

  it('refuses a cursor whose key is not shaped like a real GSI2 LastEvaluatedKey', async () => {
    const forged = encodeCursor({ chainId: CHAIN, key: { PK: 'TX#not-real', SK: 'META' } })
    const result = await handleListTxs(
      deps(),
      session,
      apiEvent({
        routeKey: 'GET /v1/relayer/txs',
        queryStringParameters: { status: 'pending', chainId: String(CHAIN), cursor: forged },
      }),
    )
    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe('invalid_cursor')
  })

  it('refuses a cursor naming a chain this listing is not walking', async () => {
    const forged = encodeCursor({
      chainId: 999_999,
      key: { PK: 'TX#x', SK: 'META', GSI2PK: 'TXPENDING#999999', GSI2SK: 1 },
    })
    const result = await handleListTxs(
      deps(),
      session,
      apiEvent({
        routeKey: 'GET /v1/relayer/txs',
        queryStringParameters: { status: 'pending', chainId: String(CHAIN), cursor: forged },
      }),
    )
    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe('invalid_cursor')
  })

  it('refuses a real cursor whose key has been swapped to another chains partition', async () => {
    await createPendingTx({ signerId: 'demo', chainId: CHAIN, createdAt: '2026-09-21T04:00:00.000Z' })
    await createPendingTx({ signerId: 'demo', chainId: CHAIN, createdAt: '2026-09-21T04:00:01.000Z' })

    const page1 = await handleListTxs(
      deps(),
      session,
      apiEvent({
        routeKey: 'GET /v1/relayer/txs',
        queryStringParameters: { status: 'pending', chainId: String(CHAIN), limit: '1' },
      }),
    )
    const body1 = page1.body as { cursor?: string }
    expect(body1.cursor).toBeDefined()

    // a real LastEvaluatedKey minted by DynamoDB itself, then forged to name OTHER_CHAIN's own partition while
    // still claiming (in the envelope) to be resuming CHAIN - the shape check alone would let this through
    const decoded = decodeCursor(body1.cursor!) as { chainId: number; key: Record<string, unknown> }
    expect(decoded.chainId).toBe(CHAIN)
    const forged = encodeCursor({
      chainId: decoded.chainId,
      key: { ...decoded.key, GSI2PK: `TXPENDING#${OTHER_CHAIN}` },
    })

    const result = await handleListTxs(
      deps(),
      session,
      apiEvent({
        routeKey: 'GET /v1/relayer/txs',
        queryStringParameters: { status: 'pending', chainId: String(CHAIN), cursor: forged },
      }),
    )
    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe('invalid_cursor')
  })
})

// direct proof, against real DynamoDB Local, that GSI2's own key attributes for this query are exactly what
// isTxListKey (relayer-routes.ts) and toStoredTx (store.ts) assume - not inferred from the route's own cursor alone
describe('the real GSI2 key this query produces', () => {
  it('matches the shape the route validates a cursor against', async () => {
    await createPendingTx({ signerId: 'demo', chainId: CHAIN, createdAt: '2026-09-21T03:00:00.000Z' })
    await createPendingTx({ signerId: 'demo', chainId: CHAIN, createdAt: '2026-09-21T03:00:01.000Z' })

    const result = await dynamo.doc.send(
      new QueryCommand({
        TableName: table,
        IndexName: GSI2,
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': `TXPENDING#${CHAIN}` },
        Limit: 1,
      }),
    )
    expect(Object.keys(result.LastEvaluatedKey ?? {}).sort()).toEqual(['GSI2PK', 'GSI2SK', 'PK', 'SK'])
    expect(typeof result.LastEvaluatedKey?.GSI2SK).toBe('number')
  })
})
