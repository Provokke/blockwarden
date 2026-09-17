import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { encodeFunctionData, erc20Abi, type Address } from 'viem'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApiHandler, ROUTES, type ApiHandler } from '../../src/api.js'
import { EstimateError } from '../../src/chain.js'
import { RelayerStore } from '../../src/store.js'
import { hashApiKey } from '../../src/submit.js'
import { FakeChain } from '../helpers/fake-chain.js'
import { CHAIN_ID, RecordingQueue, signerRecord, TARGET } from '../helpers/fixtures.js'

const FROM: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const TOKEN: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const TREASURY: Address = '0x000000000000000000000000000000000000bEEF'
const API_KEY = 'bw_test_key'

function event(routeKey: string, init: { body?: unknown; txId?: string; apiKey?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = {}
  if (init.apiKey !== null) headers.authorization = `Bearer ${init.apiKey ?? API_KEY}`
  return {
    routeKey,
    headers,
    pathParameters: init.txId === undefined ? undefined : { txId: init.txId },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2
}

const request = (overrides: Record<string, unknown> = {}) => ({
  signerId: 'billing',
  chainId: CHAIN_ID,
  to: TARGET,
  data: '0x12345678',
  idempotencyKey: `key-${Math.random()}`,
  ...overrides,
})

describe('relayer API handler', () => {
  let dynamo: Dynamo
  let store: RelayerStore
  let chain: FakeChain
  let queue: RecordingQueue
  let logs: string[]
  let handler: ApiHandler
  let ids: number

  const call = async (e: APIGatewayProxyEventV2) => {
    const result = await handler(e)
    return { status: result.statusCode, body: JSON.parse(result.body as string) }
  }

  beforeAll(async () => {
    dynamo = await startDynamo()
  })

  afterAll(async () => {
    await dynamo?.stop()
  })

  beforeEach(async () => {
    store = new RelayerStore(dynamo.doc, await dynamo.newTable())
    chain = new FakeChain(CHAIN_ID)
    queue = new RecordingQueue()
    logs = []
    ids = 0
    await store.putSigner(
      signerRecord({
        policy: {
          ...signerRecord().policy,
          allowedTo: [
            { address: TARGET },
            { address: TOKEN, selectors: ['0xa9059cbb'], transferRecipients: [TREASURY] },
          ],
        },
      }),
    )
    await store.putSigner(signerRecord({ signerId: 'other' }))
    await store.putApiKey({ hash: hashApiKey(API_KEY), signerIds: ['billing'], label: 'test', createdAt: 'x' })
    handler = createApiHandler({
      store,
      chainFor: (chainId) => (chainId === CHAIN_ID ? chain : undefined),
      addressFor: async () => FROM,
      queue,
      now: () => new Date('2026-09-17T12:00:00.000Z'),
      newTxId: () => `tx-${++ids}`,
      log: (message) => logs.push(message),
    })
  })

  describe('authentication and routing', () => {
    it('refuses a missing, malformed or unknown API key', async () => {
      for (const apiKey of [null, '', 'unknown']) {
        const e = event(ROUTES.getTx, { txId: 'x', apiKey })
        if (apiKey === '') e.headers.authorization = 'Basic abc'
        expect(await call(e)).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } })
      }
    })

    it('answers 404 for a route it does not serve', async () => {
      expect(await call(event('DELETE /v1/relayer/txs/{txId}'))).toMatchObject({ status: 404 })
    })

    it('answers 500 without detail when the store fails, and logs it', async () => {
      const broken = createApiHandler({
        store: { getApiKey: () => Promise.reject(new Error('dynamo down')) } as unknown as RelayerStore,
        chainFor: () => chain,
        addressFor: async () => FROM,
        queue,
        now: () => new Date(),
        newTxId: () => 'x',
        log: (message) => logs.push(message),
      })
      const result = await broken(event(ROUTES.getTx, { txId: 'x' }))
      expect(result.statusCode).toBe(500)
      expect(result.body).not.toContain('dynamo down')
      expect(logs).toEqual(['request failed'])
    })
  })

  describe('POST /v1/relayer/txs', () => {
    it('queues a transaction, reserves spend, enqueues it once and answers 202', async () => {
      const response = await call(event(ROUTES.submit, { body: request({ value: '5', reference: 'sub_1' }) }))
      expect(response.status).toBe(202)
      expect(response.body).toMatchObject({
        txId: 'tx-1',
        status: 'queued',
        from: FROM,
        value: '5',
        // 20% over the 50000 estimate
        gasLimit: '60000',
        nonce: null,
        hash: null,
        reference: 'sub_1',
      })
      expect(queue.sent).toEqual([{ txId: 'tx-1', enqueues: 1 }])
      expect(chain.calls).toEqual(['estimateGas'])
      expect((await store.getTx('tx-1'))?.status).toBe('queued')
    })

    it('keeps a gas limit the caller set', async () => {
      const response = await call(event(ROUTES.submit, { body: request({ gasLimit: '70000' }) }))
      expect(response.body.gasLimit).toBe('70000')
    })

    it('answers 400 with issues for an invalid body, and for a body that is not JSON', async () => {
      const invalid = await call(event(ROUTES.submit, { body: request({ to: 'nope', data: '0x1' }) }))
      expect(invalid.status).toBe(400)
      expect(invalid.body.error.issues.map((i: { path: string }) => i.path).sort()).toEqual(['data', 'to'])
      expect(await call(event(ROUTES.submit, { raw: '{nope' }))).toMatchObject({
        status: 400,
        body: { error: { code: 'invalid_json' } },
      })
    })

    it('reads a base64-encoded body', async () => {
      const e = event(ROUTES.submit)
      e.body = Buffer.from(JSON.stringify(request())).toString('base64')
      e.isBase64Encoded = true
      expect((await call(e)).status).toBe(202)
    })

    it('answers 403 for a signer outside the key allowlist and 404 for a signer that does not exist', async () => {
      expect(await call(event(ROUTES.submit, { body: request({ signerId: 'other' }) }))).toMatchObject({ status: 403 })
      await store.putApiKey({ hash: hashApiKey('bw_ghost'), signerIds: ['ghost'], label: 'x', createdAt: 'x' })
      const ghost = await call(event(ROUTES.submit, { body: request({ signerId: 'ghost' }), apiKey: 'bw_ghost' }))
      expect(ghost).toMatchObject({ status: 404, body: { error: { code: 'signer_not_found' } } })
    })

    it('answers 422 for a chain the signer or the relayer does not serve', async () => {
      const response = await call(event(ROUTES.submit, { body: request({ chainId: 1 }) }))
      expect(response).toMatchObject({ status: 422, body: { error: { code: 'chain_not_enabled' } } })
    })

    it('refuses a policy violation before any RPC call', async () => {
      const response = await call(event(ROUTES.submit, { body: request({ to: TREASURY }) }))
      expect(response).toMatchObject({ status: 422, body: { error: { code: 'policy_violation' } } })
      expect(chain.calls).toEqual([])
      expect(queue.sent).toEqual([])
    })

    it('enforces the calldata policy on an ERC-20 transfer', async () => {
      const transfer = (to: Address) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, 1n] })
      const allowed = await call(event(ROUTES.submit, { body: request({ to: TOKEN, data: transfer(TREASURY) }) }))
      expect(allowed.status).toBe(202)
      const stolen = await call(event(ROUTES.submit, { body: request({ to: TOKEN, data: transfer(FROM) }) }))
      expect(stolen).toMatchObject({ status: 422, body: { error: { code: 'policy_violation' } } })
      const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [FROM, 1n] })
      expect((await call(event(ROUTES.submit, { body: request({ to: TOKEN, data: approve }) }))).status).toBe(422)
    })

    it('refuses an estimated gas limit above the policy maximum', async () => {
      chain.gas = 900_000n
      const response = await call(event(ROUTES.submit, { body: request() }))
      expect(response).toMatchObject({ status: 422, body: { error: { code: 'policy_violation' } } })
      expect(response.body.error.issues).toEqual([{ path: 'gasLimit', message: expect.stringContaining('1000000') }])
    })

    it('answers 422 with the raw revert data when the estimate reverts, before reserving anything', async () => {
      chain.estimateFailure = new EstimateError(
        'reverted',
        'eth_estimateGas reverted',
        '0x11fbe7120000000000000000000000000000000000000000000000000000000000000007',
      )
      const response = await call(event(ROUTES.submit, { body: request() }))
      expect(response).toMatchObject({
        status: 422,
        body: { error: { code: 'estimate_reverted', revertData: chain.estimateFailure.revertData } },
      })
      expect(queue.sent).toEqual([])
      expect(await store.getTx('tx-1')).toBeUndefined()
    })

    it('answers 503 when the RPC is unavailable and 422 when the estimate fails another way', async () => {
      chain.estimateFailure = new EstimateError('unavailable', 'down')
      expect((await call(event(ROUTES.submit, { body: request() }))).status).toBe(503)
      chain.estimateFailure = new EstimateError('failed', 'gas required exceeds allowance')
      expect(await call(event(ROUTES.submit, { body: request() }))).toMatchObject({
        status: 422,
        body: { error: { code: 'estimate_failed' } },
      })
    })

    it('returns the original transaction for a repeated idempotency key, and 409 for a different body', async () => {
      const body = request({ idempotencyKey: 'charge-7' })
      const first = await call(event(ROUTES.submit, { body }))
      const again = await call(event(ROUTES.submit, { body }))
      expect(again).toEqual({ status: 200, body: first.body })
      expect(queue.sent).toHaveLength(1)
      const changed = await call(event(ROUTES.submit, { body: { ...body, data: '0xdeadbeef' } }))
      expect(changed).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } })
    })

    it('creates one transaction when the same key arrives concurrently', async () => {
      const body = request({ idempotencyKey: 'race' })
      const responses = await Promise.all(Array.from({ length: 5 }, () => call(event(ROUTES.submit, { body }))))
      const txIds = new Set(responses.map((r) => r.body.txId))
      expect(txIds.size).toBe(1)
      expect(responses.filter((r) => r.status === 202)).toHaveLength(1)
      expect(queue.sent).toHaveLength(1)
    })

    it('answers 422 once the daily spend cap is used up', async () => {
      // each request reserves 60000 gas at the 100 gwei fee cap, 0.006 ETH, so a 0.012 ETH cap allows two
      await store.putSigner(
        signerRecord({ policy: { ...signerRecord().policy, dailySpendCapWei: '12000000000000000' } }),
      )
      expect((await call(event(ROUTES.submit, { body: request() }))).status).toBe(202)
      expect((await call(event(ROUTES.submit, { body: request() }))).status).toBe(202)
      expect(await call(event(ROUTES.submit, { body: request() }))).toMatchObject({
        status: 422,
        body: { error: { code: 'spend_cap_exceeded' } },
      })
    })

    it('still answers 202 when enqueueing fails, leaving the transaction for the sweeper', async () => {
      queue.failNext = true
      const response = await call(event(ROUTES.submit, { body: request() }))
      expect(response.status).toBe(202)
      expect((await store.getTx(response.body.txId))?.status).toBe('queued')
      expect(logs).toEqual(['enqueue failed; the sweeper will requeue it'])
    })
  })

  describe('GET routes', () => {
    it('returns a transaction of an allowed signer and hides one of another signer', async () => {
      const created = await call(event(ROUTES.submit, { body: request() }))
      expect(await call(event(ROUTES.getTx, { txId: created.body.txId }))).toEqual({ status: 200, body: created.body })
      await store.putApiKey({ hash: hashApiKey('bw_other'), signerIds: ['other'], label: 'x', createdAt: 'x' })
      expect(await call(event(ROUTES.getTx, { txId: created.body.txId, apiKey: 'bw_other' }))).toMatchObject({
        status: 404,
      })
      expect(await call(event(ROUTES.getTx, { txId: 'missing' }))).toMatchObject({ status: 404 })
    })

    it('lists the signers the key may use with their addresses', async () => {
      expect(await call(event(ROUTES.signers))).toEqual({
        status: 200,
        body: { signers: [{ signerId: 'billing', address: FROM, chainIds: [CHAIN_ID] }] },
      })
    })
  })
})
