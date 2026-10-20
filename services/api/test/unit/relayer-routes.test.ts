import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { describe, expect, it } from 'vitest'
import { handleGetTx, handleListSigners, handleListTxs, type RelayerDeps } from '../../src/relayer-routes.js'
import type { Caller } from '../../src/caller.js'
import { decodeCursor, encodeCursor } from '../../src/http.js'
import type { RelayerStore, StoredTx } from '../../src/store.js'

const session: Caller = { kind: 'session', address: '0x1111111111111111111111111111111111111111' }
const key: Caller = { kind: 'apiKey', hash: 'a'.repeat(64), signerIds: ['demo'], label: 'ci' }

function pendingTx(chainId: number, n: number, signerId: string): StoredTx {
  return {
    txId: `tx-${chainId}-${n}`,
    signerId,
    chainId,
    status: 'pending',
    createdAt: new Date(2026, 8, n).toISOString(),
  }
}

// a page key shaped like the one the real store returns for a pending-tx query (relayer-routes.ts's
// TX_LIST_KEY_ATTRS: PK, SK, GSI2PK as strings, GSI2SK a number), so this fake exercises the same cursor
// shape-and-value check the real store's key would have to pass (matches.test.ts's pageKey does the same for
// matches, deliveries.test.ts's for deliveries). `order` stands in for the real GSI2SK (createdAt epoch ms) -
// only its relative ordering matters to this fake, not its absolute value.
function pendingKey(chainId: number, tx: StoredTx, order: number): Record<string, unknown> {
  return { PK: `TX#${tx.txId}`, SK: 'META', GSI2PK: `TXPENDING#${chainId}`, GSI2SK: order }
}

// holds pending rows per chain and honours chainId, limit and cursor - a fake that ignored any of the three
// would pass every test that exercises paging or multi-chain walking without actually proving either works
function fakePendingStore(pending: Record<number, StoredTx[]>): RelayerStore['listPendingTxs'] {
  return async (chainId, limit, cursor) => {
    const rows = pending[chainId] ?? []
    const from = cursor === undefined ? 0 : (cursor.GSI2SK as number) + 1
    const page = rows.slice(from, from + limit)
    const lastOrder = from + page.length - 1
    const next =
      page.length > 0 && from + page.length < rows.length ? pendingKey(chainId, rows[lastOrder]!, lastOrder) : undefined
    return { txs: page, ...(next ? { cursor: next } : {}) }
  }
}

// default fixture: two chains, three pending rows split 2/1 across them, each chain's rows already in the
// oldest-first order the real GSI2 query returns
const PENDING: Record<number, StoredTx[]> = {
  8453: [pendingTx(8453, 1, 'demo'), pendingTx(8453, 2, 'treasury')],
  42161: [pendingTx(42161, 1, 'treasury')],
}

// the shape Terraform writes: a signer id and its chains, with no address (Terraform has no keccak256)
function deps(pending: Record<number, StoredTx[]> = PENDING): RelayerDeps {
  return {
    store: {
      async listSigners() {
        return [
          { signerId: 'treasury', chainIds: [42161] },
          { signerId: 'demo', chainIds: [8453] },
        ]
      },
      async getTx(txId) {
        if (txId !== 'tx-1' && txId !== 'tx-2') return undefined
        return {
          txId,
          signerId: txId === 'tx-1' ? 'demo' : 'treasury',
          chainId: 8453,
          status: 'confirmed',
          createdAt: '2026-09-21T00:00:00.000Z',
          nonce: 4,
          hash: '0x' + 'c'.repeat(64),
          blockNumber: '19000000',
        }
      },
      listPendingTxs: fakePendingStore(pending),
    },
  }
}

// narrowed to the real event type rather than to `never`, same helper as rules.test.ts's/matches.test.ts's apiEvent
function event(over: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /v1/relayer/signers',
    headers: {},
    ...over,
  } as APIGatewayProxyEventV2
}

describe('handleListSigners', () => {
  it('shows a session every signer', async () => {
    const result = await handleListSigners(deps(), session, event())
    expect((result.body as { signers: unknown[] }).signers).toHaveLength(2)
  })

  it('shows an API key only the signers it may use', async () => {
    const result = await handleListSigners(deps(), key, event())
    const signers = (result.body as { signers: { signerId: string }[] }).signers
    expect(signers.map((s) => s.signerId)).toEqual(['demo'])
  })
})

describe('handleGetTx', () => {
  it('returns a transaction to a session', async () => {
    const result = await handleGetTx(deps(), session, event({ pathParameters: { txId: 'tx-1' } }))
    expect(result.status).toBe(200)
  })

  it('reads a transaction of another signer as missing, so ids cannot be probed', async () => {
    const result = await handleGetTx(deps(), key, event({ pathParameters: { txId: 'tx-2' } }))
    expect(result.status).toBe(404)
    expect((result.body as { error: { code: string } }).error.code).toBe('tx_not_found')
  })

  it('returns the block number as a string', async () => {
    const result = await handleGetTx(deps(), session, event({ pathParameters: { txId: 'tx-1' } }))
    expect(typeof (result.body as { blockNumber: unknown }).blockNumber).toBe('string')
  })
})

describe('handleListTxs', () => {
  it('refuses a status with no index behind it', async () => {
    const result = await handleListTxs(deps(), session, event({ queryStringParameters: { status: 'confirmed' } }))
    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe('unsupported_status')
  })

  it('lists pending transactions, which is the one indexed view, with the real rows the store holds', async () => {
    const result = await handleListTxs(deps(), session, event({ queryStringParameters: { status: 'pending' } }))
    expect(result.status).toBe(200)
    const txIds = (result.body as { txs: StoredTx[] }).txs.map((tx) => tx.txId).sort()
    expect(txIds).toEqual(['tx-42161-1', 'tx-8453-1', 'tx-8453-2'])
  })

  it('refuses a chain the deployment does not relay on', async () => {
    const result = await handleListTxs(
      deps(),
      session,
      event({ queryStringParameters: { status: 'pending', chainId: '1' } }),
    )
    expect(result.status).toBe(400)
  })

  it('lists a single chain honouring the limit and resumes from its cursor with no duplicate and no gap', async () => {
    const d = deps({ 8453: [pendingTx(8453, 1, 'demo'), pendingTx(8453, 2, 'demo'), pendingTx(8453, 3, 'demo')] })
    const first = await handleListTxs(
      d,
      session,
      event({ queryStringParameters: { status: 'pending', chainId: '8453', limit: '2' } }),
    )
    const firstBody = first.body as { txs: StoredTx[]; cursor?: string }
    expect(firstBody.txs.map((tx) => tx.txId)).toEqual(['tx-8453-1', 'tx-8453-2'])
    expect(firstBody.cursor).toBeDefined()

    const second = await handleListTxs(
      d,
      session,
      event({ queryStringParameters: { status: 'pending', chainId: '8453', cursor: firstBody.cursor! } }),
    )
    const secondBody = second.body as { txs: StoredTx[]; cursor?: string }
    expect(secondBody.txs.map((tx) => tx.txId)).toEqual(['tx-8453-3'])
    expect(secondBody.cursor).toBeUndefined()
  })

  it('walks into the next chain when the first one ends exactly at the page limit, with no chainId given', async () => {
    const d = deps({
      8453: [pendingTx(8453, 1, 'demo'), pendingTx(8453, 2, 'demo')],
      42161: [pendingTx(42161, 1, 'treasury')],
    })
    const first = await handleListTxs(d, session, event({ queryStringParameters: { status: 'pending', limit: '2' } }))
    const firstBody = first.body as { txs: StoredTx[]; cursor?: string }
    expect(firstBody.txs.map((tx) => tx.txId)).toEqual(['tx-8453-1', 'tx-8453-2'])
    expect(firstBody.cursor).toBeDefined()
    expect(decodeCursor(firstBody.cursor!)).toMatchObject({ chainId: 42161 })

    const second = await handleListTxs(
      d,
      session,
      event({ queryStringParameters: { status: 'pending', limit: '2', cursor: firstBody.cursor! } }),
    )
    const secondBody = second.body as { txs: StoredTx[]; cursor?: string }
    expect(secondBody.txs.map((tx) => tx.txId)).toEqual(['tx-42161-1'])
    expect(secondBody.cursor).toBeUndefined()
  })

  it('carries the reduced budget into the next chain within one request, not the full page size again', async () => {
    // chain 8453 exhausts under the limit (1 of 1, no cursor) so the ordinary loop continues into 42161 within
    // this same call - proving `limit - txs.length` reaches the second chain's own store call, not `limit`
    // again, which would let it hand back more rows than this page was ever asked for
    const d = deps({
      8453: [pendingTx(8453, 1, 'demo')],
      42161: [pendingTx(42161, 1, 'treasury'), pendingTx(42161, 2, 'treasury'), pendingTx(42161, 3, 'treasury')],
    })
    const result = await handleListTxs(d, session, event({ queryStringParameters: { status: 'pending', limit: '3' } }))
    const body = result.body as { txs: StoredTx[]; cursor?: string }
    expect(body.txs.map((tx) => tx.txId)).toEqual(['tx-8453-1', 'tx-42161-1', 'tx-42161-2'])
    expect(body.cursor).toBeDefined()
  })

  it('walks the chains its signers list in ascending order, whatever order the signers come back in', async () => {
    const first = await handleListTxs(
      deps(),
      session,
      event({ queryStringParameters: { status: 'pending', limit: '2' } }),
    )
    const body = first.body as { txs: StoredTx[]; cursor?: string }
    expect(body.txs.map((tx) => tx.txId)).toEqual(['tx-8453-1', 'tx-8453-2'])
  })

  it('lists only the chains of the signers an API key may use, and refuses the others', async () => {
    const listed = await handleListTxs(deps(), key, event({ queryStringParameters: { status: 'pending' } }))
    expect((listed.body as { txs: StoredTx[] }).txs.map((tx) => tx.txId)).toEqual(['tx-8453-1'])

    const refused = await handleListTxs(
      deps(),
      key,
      event({ queryStringParameters: { status: 'pending', chainId: '42161' } }),
    )
    expect(refused.status).toBe(400)
    expect((refused.body as { error: { code: string } }).error.code).toBe('unknown_chain')
  })

  it('refuses a cursor whose key names a different chains partition than the one it claims to resume', async () => {
    // shaped exactly right - PK/SK/GSI2PK strings, GSI2SK a number - but GSI2PK is another chain's partition
    // while the envelope's own chainId is the one this listing is walking (84532 is what the integration test
    // walks; here it stands in as "a chain this deployment relays on")
    const forged = encodeCursor({
      chainId: 8453,
      key: { PK: 'TX#tx-8453-1', SK: 'META', GSI2PK: 'TXPENDING#42161', GSI2SK: 0 },
    })
    const result = await handleListTxs(
      deps(),
      session,
      event({ queryStringParameters: { status: 'pending', chainId: '8453', cursor: forged } }),
    )
    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe('invalid_cursor')
  })
})
