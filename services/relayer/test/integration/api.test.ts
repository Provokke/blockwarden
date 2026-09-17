import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { encodeFunctionData, erc20Abi, HttpRequestError, type Address } from 'viem'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApiHandler, ROUTES, type ApiHandler } from '../../src/api.js'
import { describeError, EstimateError } from '../../src/chain.js'
import { RelayerStore, StoreBusyError } from '../../src/store.js'
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
      log: (message, _data, level) => logs.push(level ? `${level}: ${message}` : message),
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
        log: (message, _data, level) => logs.push(level ? `${level}: ${message}` : message),
      })
      const result = await broken(event(ROUTES.getTx, { txId: 'x' }))
      expect(result.statusCode).toBe(500)
      expect(result.body).not.toContain('dynamo down')
      expect(logs).toEqual(['error: request failed'])
    })

    it('logs a failure as its short description, never the error itself with an RPC URL inside', async () => {
      const failure = new HttpRequestError({
        url: 'https://base-sepolia.example/v2/SECRET-RPC-KEY',
        details: 'fetch failed',
      })
      const entries: Record<string, unknown>[] = []
      const broken = createApiHandler({
        store: { getApiKey: () => Promise.reject(failure) } as unknown as RelayerStore,
        chainFor: () => chain,
        addressFor: async () => FROM,
        queue,
        now: () => new Date(),
        newTxId: () => 'x',
        log: (_message, data) => entries.push(data ?? {}),
      })
      expect((await broken(event(ROUTES.getTx, { txId: 'x' }))).statusCode).toBe(500)
      expect(entries).toEqual([{ routeKey: ROUTES.getTx, error: describeError(failure) }])
      expect(JSON.stringify(entries)).not.toContain('SECRET-RPC-KEY')
    })

    it('answers 500 without detail when something that is not an Error is thrown, and logs it', async () => {
      const broken = createApiHandler({
        store: {
          getApiKey: () => {
            throw undefined
          },
        } as unknown as RelayerStore,
        chainFor: () => chain,
        addressFor: async () => FROM,
        queue,
        now: () => new Date(),
        newTxId: () => 'x',
        log: (message, _data, level) => logs.push(level ? `${level}: ${message}` : message),
      })
      const result = await broken(event(ROUTES.getTx, { txId: 'x' }))
      expect(result.statusCode).toBe(500)
      expect(logs).toEqual(['error: request failed'])
    })

    it('accepts the Bearer scheme case-insensitively', async () => {
      const e = event(ROUTES.signers)
      e.headers.authorization = `bearer ${API_KEY}`
      expect((await call(e)).status).toBe(200)
    })

    it('answers 503 busy when the store cannot resolve a DynamoDB conflict, and tells the caller to retry', async () => {
      const busyStore = {
        getApiKey: store.getApiKey.bind(store),
        getIdempotency: store.getIdempotency.bind(store),
        getSigner: store.getSigner.bind(store),
        createTx: () => Promise.reject(new StoreBusyError('creating transaction tx-1')),
      } as unknown as RelayerStore
      const busy = createApiHandler({
        store: busyStore,
        chainFor: (chainId) => (chainId === CHAIN_ID ? chain : undefined),
        addressFor: async () => FROM,
        queue,
        now: () => new Date('2026-09-17T12:00:00.000Z'),
        newTxId: () => 'tx-busy',
        log: (message, _data, level) => logs.push(level ? `${level}: ${message}` : message),
      })
      const raw = await busy(event(ROUTES.submit, { body: request() }))
      const result = { status: raw.statusCode, body: JSON.parse(raw.body as string) }
      expect(result).toMatchObject({ status: 503, body: { error: { code: 'busy' } } })
      expect(result.body.error.message).toMatch(/idempotency/i)
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

    it('answers 503 when the RPC is unavailable and 422 when the estimate fails another way, storing nothing either time', async () => {
      chain.estimateFailure = new EstimateError('unavailable', 'down')
      expect((await call(event(ROUTES.submit, { body: request({ idempotencyKey: 'unavailable-1' }) }))).status).toBe(
        503,
      )
      expect(await store.getIdempotency(hashApiKey(API_KEY), 'unavailable-1')).toBeUndefined()

      chain.estimateFailure = new EstimateError('failed', 'gas required exceeds allowance')
      expect(await call(event(ROUTES.submit, { body: request({ idempotencyKey: 'failed-1' }) }))).toMatchObject({
        status: 422,
        body: { error: { code: 'estimate_failed' } },
      })
      expect(await store.getIdempotency(hashApiKey(API_KEY), 'failed-1')).toBeUndefined()
    })

    it('returns a fixed message per estimate error kind instead of the raw RPC text, and logs the detail', async () => {
      const secret = 'https://rpc.example/key/super-secret-api-key'

      chain.estimateFailure = new EstimateError('reverted', `eth_estimateGas reverted at ${secret}`, '0xdead')
      const reverted = await call(event(ROUTES.submit, { body: request({ idempotencyKey: 'msg-reverted' }) }))
      expect(reverted.body.error.message).not.toContain(secret)
      expect(reverted.body.error.revertData).toBe('0xdead')

      chain.estimateFailure = new EstimateError('unavailable', `connect ECONNREFUSED ${secret}`)
      const unavailable = await call(event(ROUTES.submit, { body: request({ idempotencyKey: 'msg-unavailable' }) }))
      expect(unavailable.body.error.message).not.toContain(secret)

      chain.estimateFailure = new EstimateError('failed', `gas required exceeds allowance at ${secret}`)
      const failed = await call(event(ROUTES.submit, { body: request({ idempotencyKey: 'msg-failed' }) }))
      expect(failed.body.error.message).not.toContain(secret)

      expect(logs.filter((l) => l === 'warn: estimate failed')).toHaveLength(3)
    })

    it('treats leading zeros in a decimal string as unchanged for idempotency', async () => {
      const key = 'zeros-1'
      const first = await call(
        event(ROUTES.submit, { body: request({ idempotencyKey: key, value: '00', gasLimit: '060000' }) }),
      )
      expect(first.status).toBe(202)
      const again = await call(
        event(ROUTES.submit, { body: request({ idempotencyKey: key, value: '0', gasLimit: '60000' }) }),
      )
      expect(again).toEqual({ status: 200, body: first.body })
    })

    it('hashes an omitted value the same as "0"', async () => {
      const key = 'omit-value-1'
      const first = await call(event(ROUTES.submit, { body: request({ idempotencyKey: key }) }))
      expect(first.status).toBe(202)
      const again = await call(event(ROUTES.submit, { body: request({ idempotencyKey: key, value: '0' }) }))
      expect(again).toEqual({ status: 200, body: first.body })
    })

    it('lets two different API keys use the same idempotencyKey to create separate transactions', async () => {
      await store.putApiKey({ hash: hashApiKey('bw_second'), signerIds: ['billing'], label: 'second', createdAt: 'x' })
      const key = 'shared-key'
      const first = await call(event(ROUTES.submit, { body: request({ idempotencyKey: key }) }))
      const second = await call(event(ROUTES.submit, { body: request({ idempotencyKey: key }), apiKey: 'bw_second' }))
      expect(first.status).toBe(202)
      expect(second.status).toBe(202)
      expect(second.body.txId).not.toBe(first.body.txId)
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
      expect(logs).toEqual(['warn: enqueue failed; the sweeper will requeue it'])
    })
  })

  describe('dependsOn', () => {
    const depend = async (overrides: Record<string, unknown> = {}) =>
      call(event(ROUTES.submit, { body: request({ gasLimit: '80000', ...overrides }) }))

    it('queues a dependent transaction without estimating it', async () => {
      const first = await call(event(ROUTES.submit, { body: request() }))
      chain.calls = []
      const dependent = await depend({ dependsOn: first.body.txId })
      expect(dependent).toMatchObject({ status: 202, body: { dependsOn: first.body.txId, gasLimit: '80000' } })
      expect(chain.calls).toEqual([])
    })

    it('needs a gas limit', async () => {
      const first = await call(event(ROUTES.submit, { body: request() }))
      const response = await call(event(ROUTES.submit, { body: request({ dependsOn: first.body.txId }) }))
      expect(response).toMatchObject({ status: 400, body: { error: { issues: [{ path: 'gasLimit' }] } } })
    })

    it('refuses a dependency that is missing, belongs to a signer the key may not use, or is on another chain', async () => {
      expect(await depend({ dependsOn: 'missing' })).toMatchObject({
        status: 422,
        body: { error: { code: 'dependency_not_found' } },
      })
      await store.putApiKey({ hash: hashApiKey('bw_other'), signerIds: ['other'], label: 'x', createdAt: 'x' })
      const theirs = await call(event(ROUTES.submit, { body: request({ signerId: 'other' }), apiKey: 'bw_other' }))
      expect(theirs.status).toBe(202)
      expect(await depend({ dependsOn: theirs.body.txId })).toMatchObject({
        status: 422,
        body: { error: { code: 'dependency_not_found' } },
      })
      const first = await call(event(ROUTES.submit, { body: request() }))
      const tx = (await store.getTx(first.body.txId))!
      await store.saveTx({ ...tx, chainId: 421614 }, 'x')
      expect(await depend({ dependsOn: first.body.txId })).toMatchObject({
        body: { error: { code: 'dependency_not_found' } },
      })
    })

    it('refuses a dependency that already failed or reverted', async () => {
      const first = await call(event(ROUTES.submit, { body: request() }))
      const tx = (await store.getTx(first.body.txId))!
      const reverted = await store.saveTx(
        {
          ...tx,
          status: 'confirmed',
          mined: { hash: `0x${'1'.repeat(64)}`, blockNumber: 1, blockHash: `0x${'2'.repeat(64)}`, status: 'reverted' },
        },
        'x',
      )
      expect(await depend({ dependsOn: tx.txId })).toMatchObject({
        status: 422,
        body: { error: { code: 'dependency_failed' } },
      })
      await store.saveTx({ ...reverted, status: 'failed' }, 'x')
      expect(await depend({ dependsOn: tx.txId })).toMatchObject({
        status: 422,
        body: { error: { code: 'dependency_failed' } },
      })
    })

    it('refuses a dependency that was cancelled', async () => {
      const first = await call(event(ROUTES.submit, { body: request() }))
      const tx = (await store.getTx(first.body.txId))!
      await store.saveTx({ ...tx, status: 'cancelled' }, 'x')
      expect(await depend({ dependsOn: tx.txId })).toMatchObject({
        status: 422,
        body: { error: { code: 'dependency_failed' } },
      })
    })

    it('is part of the idempotency request hash', async () => {
      const a = await call(event(ROUTES.submit, { body: request({ idempotencyKey: 'dep-a' }) }))
      const b = await call(event(ROUTES.submit, { body: request({ idempotencyKey: 'dep-b' }) }))
      const key = 'depends-on-key'
      const first = await depend({ idempotencyKey: key, dependsOn: a.body.txId })
      expect(first.status).toBe(202)
      expect(await depend({ idempotencyKey: key, dependsOn: b.body.txId })).toMatchObject({
        status: 409,
        body: { error: { code: 'idempotency_conflict' } },
      })
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
