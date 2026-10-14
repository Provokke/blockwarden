import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { describe, expect, it } from 'vitest'
import { handleGetTx, handleListSigners, handleListTxs, type RelayerDeps } from '../../src/relayer-routes.js'
import type { Caller } from '../../src/caller.js'

const session: Caller = { kind: 'session', address: '0x1111111111111111111111111111111111111111' }
const key: Caller = { kind: 'apiKey', hash: 'a'.repeat(64), signerIds: ['demo'], label: 'ci' }

function deps(): RelayerDeps {
  return {
    store: {
      async listSigners() {
        return [
          { signerId: 'demo', chainIds: [8453], address: '0x' + 'a'.repeat(40) },
          { signerId: 'treasury', chainIds: [42161], address: '0x' + 'b'.repeat(40) },
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
      async listPendingTxs(chainId, limit, cursor) {
        void chainId
        void limit
        void cursor
        return { txs: [] }
      },
    },
    chainIds: [8453, 42161],
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

  it('lists pending transactions, which is the one indexed view', async () => {
    const result = await handleListTxs(deps(), session, event({ queryStringParameters: { status: 'pending' } }))
    expect(result.status).toBe(200)
  })

  it('refuses a chain the deployment does not relay on', async () => {
    const result = await handleListTxs(
      deps(),
      session,
      event({ queryStringParameters: { status: 'pending', chainId: '1' } }),
    )
    expect(result.status).toBe(400)
  })
})
