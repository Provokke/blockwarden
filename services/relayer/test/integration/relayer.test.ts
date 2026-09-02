import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { getTx, listSigners, relay, RelayerApiError, type RelayerClientOptions } from '@blockwarden/relayer-client'
import { decodeErrorResult, encodeFunctionData, type Address, type Hex, type LocalAccount } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApiHandler } from '../../src/api.js'
import { processRecords } from '../../src/batch.js'
import { createRelayerChain, type RelayerChain } from '../../src/chain.js'
import { sqsTxQueue, type TxQueue } from '../../src/queue.js'
import type { TxRecord } from '../../src/records.js'
import { processTx, type SignerDeps } from '../../src/signer.js'
import { RelayerStore } from '../../src/store.js'
import { hashApiKey } from '../../src/submit.js'
import { sweepChain, type SweepSummary } from '../../src/sweeper.js'
import { startAnvil, TARGET_ABI, type Anvil } from '../helpers/anvil.js'
import { localAccount, signerRecord } from '../helpers/fixtures.js'
import { serveApi } from '../helpers/http.js'
import { startMoto, type Moto } from '../helpers/moto.js'

const API_KEY = 'bw_e2e_key'
const ETH = 10n ** 18n

// relayer-client -> HTTP -> API handler -> DynamoDB Local + SQS FIFO on moto -> signer -> Anvil -> sweeper
describe('relayer end to end', () => {
  let anvil: Anvil
  let dynamo: Dynamo
  let moto: Moto
  let target: Address
  let chain: RelayerChain

  // fresh per test: a table, a queue, a signer key and a signer container
  let store: RelayerStore
  let queueUrl: string
  let queue: TxQueue
  let privateKey: Hex
  let account: LocalAccount
  let signerDeps: SignerDeps
  let api: { url: string; close(): Promise<void> }
  let client: RelayerClientOptions
  let signerId: string
  let signers = 0

  beforeAll(async () => {
    ;[anvil, dynamo, moto] = await Promise.all([startAnvil(), startDynamo(), startMoto()])
    target = await anvil.deployTarget()
    chain = createRelayerChain(anvil.chainId, [anvil.rpcUrl])
  })

  afterAll(async () => {
    await Promise.all([anvil?.stop(), dynamo?.stop(), moto?.stop()])
  })

  beforeEach(async () => {
    store = new RelayerStore(dynamo.doc, await dynamo.newTable())
    queueUrl = await moto.newFifoQueue()
    queue = sqsTxQueue(moto.sqs, queueUrl)
    privateKey = generatePrivateKey()
    account = await localAccount(privateKey)
    signerId = `signer-${++signers}`
    await anvil.setBalance(account.address, 10n * ETH)
    await store.putSigner(
      signerRecord({
        signerId,
        chainIds: [anvil.chainId],
        policy: { ...signerRecord().policy, allowedTo: [{ address: target }], dailySpendCapWei: String(5n * ETH) },
      }),
    )
    await store.putApiKey({ hash: hashApiKey(API_KEY), signerIds: [signerId], label: 'e2e', createdAt: 'x' })
    const chainFor = (chainId: number) => (chainId === anvil.chainId ? chain : undefined)
    signerDeps = {
      store,
      chainFor,
      accountFor: async () => account,
      queue,
      now: () => new Date(),
      newTxId: () => crypto.randomUUID(),
      reconciled: new Set(),
      log: () => {},
    }
    api = await serveApi(
      createApiHandler({
        store,
        chainFor,
        addressFor: async () => account.address,
        queue,
        now: () => new Date(),
        newTxId: () => crypto.randomUUID(),
        log: () => {},
      }),
    )
    client = { baseUrl: api.url, apiKey: API_KEY }
  })

  afterEach(async () => {
    await api?.close()
    await anvil.setAutomine(true)
  })

  const ping = (value: bigint) => encodeFunctionData({ abi: TARGET_ABI, functionName: 'ping', args: [value] })
  const relayPing = (value: bigint, extra: { idempotencyKey?: string; gasLimit?: bigint } = {}) =>
    relay(client, {
      signerId,
      chainId: anvil.chainId,
      to: target,
      data: ping(value),
      idempotencyKey: extra.idempotencyKey ?? `ping-${value}-${Math.random()}`,
      ...(extra.gasLimit === undefined ? {} : { gasLimit: extra.gasLimit }),
    })
  const drain = () =>
    moto.drain(queueUrl, (records) =>
      processRecords(
        records,
        (txId) => processTx(signerDeps, txId),
        () => {},
      ),
    )
  const sweep = (stuckAfterMs = 90_000): Promise<SweepSummary> =>
    sweepChain(
      {
        store,
        chain,
        settings: { chainId: anvil.chainId, confirmations: 5, stuckAfterMs },
        accountFor: async () => account,
        queue,
        now: () => new Date(),
        requeueAfterMs: 600_000,
        log: () => {},
      },
      Date.now() + 30_000,
    )
  const record = async (txId: string): Promise<TxRecord> => (await store.getTx(txId))!

  it('relays a transaction to confirmed, visible through the client', async () => {
    const queued = await relayPing(1n, { idempotencyKey: 'first', gasLimit: 100_000n })
    expect(queued).toMatchObject({
      status: 'queued',
      from: account.address,
      gasLimit: 100_000n,
      idempotencyKey: 'first',
    })
    expect(await listSigners(client)).toEqual([{ signerId, address: account.address, chainIds: [anvil.chainId] }])

    await drain()
    expect((await getTx(client, queued.txId)).status).toBe('submitted')
    expect(await sweep()).toMatchObject({ mined: 1, confirmed: 0 })
    await anvil.mine(4)
    expect(await sweep()).toMatchObject({ confirmed: 1 })

    const confirmed = await getTx(client, queued.txId)
    expect(confirmed).toMatchObject({ status: 'confirmed', nonce: 0, receiptStatus: 'success' })
    const receipt = await anvil.publicClient.getTransactionReceipt({ hash: confirmed.hash! })
    expect(receipt).toMatchObject({ from: account.address.toLowerCase(), blockNumber: BigInt(confirmed.blockNumber!) })
    expect(receipt.logs).toHaveLength(1)
  })

  it('signs one signer’s transactions in the order they were submitted', async () => {
    const txs = []
    for (let i = 0; i < 4; i++) txs.push(await relayPing(BigInt(i)))
    await drain()
    const nonces = await Promise.all(txs.map(async (tx) => (await record(tx.txId)).nonce))
    expect(nonces).toEqual([0, 1, 2, 3])
    await sweep()
    for (const tx of txs) expect((await record(tx.txId)).status).toBe('mined')
  })

  it('returns the original transaction for a repeated idempotency key and sends it once', async () => {
    const first = await relayPing(7n, { idempotencyKey: 'charge-7' })
    const again = await relayPing(7n, { idempotencyKey: 'charge-7' })
    expect(again.txId).toBe(first.txId)
    expect(await drain()).toHaveLength(1)
  })

  it('refuses a reverting call with 422 and revert data the caller can decode', async () => {
    const err = await relay(client, {
      signerId,
      chainId: anvil.chainId,
      to: target,
      data: encodeFunctionData({ abi: TARGET_ABI, functionName: 'fail', args: [7n] }),
      idempotencyKey: 'fail-7',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayerApiError)
    const apiError = err as RelayerApiError
    expect(apiError).toMatchObject({ status: 422, code: 'estimate_reverted' })
    expect(decodeErrorResult({ abi: TARGET_ABI, data: apiError.revertData! })).toMatchObject({
      errorName: 'NotAllowed',
      args: [7n],
    })
  })

  it('reports a mined transaction that reverted', async () => {
    // enough for intrinsic gas, not for the event
    const tx = await relayPing(3n, { gasLimit: 22_000n })
    await drain()
    await sweep()
    expect(await getTx(client, tx.txId)).toMatchObject({ status: 'mined', receiptStatus: 'reverted' })
  })

  it('replaces a dropped transaction at the same nonce', async () => {
    await anvil.setAutomine(false)
    const tx = await relayPing(4n)
    await drain()
    const sent = await record(tx.txId)
    await anvil.dropTransaction(sent.attempts[0]!.hash)

    expect(await sweep(0)).toMatchObject({ replaced: 1 })
    await anvil.mine(1)
    expect(await sweep(0)).toMatchObject({ mined: 1 })
    const mined = await record(tx.txId)
    expect(mined.attempts).toHaveLength(2)
    expect(mined.mined?.hash).toBe(mined.attempts[1]!.hash)
    expect(mined.nonce).toBe(sent.nonce)
    const onChain = await anvil.publicClient.getTransaction({ hash: mined.mined!.hash })
    expect(onChain.nonce).toBe(sent.nonce)
    expect(onChain.maxFeePerGas! > BigInt(sent.attempts[0]!.maxFeePerGas)).toBe(true)
  })

  it('puts a reorged transaction back, rebroadcasts it and confirms it in its new block', async () => {
    const tx = await relayPing(5n)
    await drain()
    await sweep()
    const firstMined = (await record(tx.txId)).mined!

    await anvil.reorg(1)
    expect(await sweep()).toMatchObject({ reorged: 1 })
    expect((await record(tx.txId)).status).toBe('submitted')
    // automine puts the rebroadcast transaction into a new block straight away
    expect(await sweep()).toMatchObject({ mined: 1 })
    const secondMined = (await record(tx.txId)).mined!
    expect(secondMined.hash).toBe(firstMined.hash)
    expect(secondMined.blockHash).not.toBe(firstMined.blockHash)
    await anvil.mine(5)
    expect(await sweep()).toMatchObject({ confirmed: 1 })
  })

  it('fills the nonce of a transaction the node refused, so the next one is not blocked', async () => {
    // below the 21000 intrinsic gas: the estimate passes, the node refuses the signed transaction
    const refused = await relayPing(6n, { gasLimit: 20_000n })
    await drain()
    const failed = await getTx(client, refused.txId)
    expect(failed).toMatchObject({ status: 'failed', nonce: 0 })
    expect(failed.error).toContain('intrinsic gas too low')
    expect(failed.fillerTxId).not.toBeNull()

    const next = await relayPing(7n)
    await drain()
    await sweep()
    const filler = await getTx(client, failed.fillerTxId!)
    expect(filler).toMatchObject({ kind: 'filler', status: 'mined', nonce: 0, to: account.address, value: 0n })
    expect(await record(next.txId)).toMatchObject({ status: 'mined', nonce: 1 })
  })

  it('pauses a signer without funds and resumes it once funded', async () => {
    await anvil.setBalance(account.address, 0n)
    const tx = await relayPing(8n)
    await drain()
    expect(await record(tx.txId)).toMatchObject({ status: 'queued', nonce: 0 })
    expect(await store.getPause(signerId, anvil.chainId)).toBeDefined()
    expect(await sweep()).toMatchObject({ resumed: 0, requeued: 0 })

    await anvil.setBalance(account.address, ETH)
    expect(await sweep()).toMatchObject({ resumed: 1, requeued: 1 })
    await drain()
    await sweep()
    expect(await record(tx.txId)).toMatchObject({ status: 'mined', nonce: 0 })
  })

  it('holds a transaction that depends on another until that one is confirmed', async () => {
    const call = (functionName: 'arm' | 'fire') => encodeFunctionData({ abi: TARGET_ABI, functionName })
    // without the dependency the API refuses fire, because its estimate reverts until arm is mined
    await expect(
      relay(client, { signerId, chainId: anvil.chainId, to: target, data: call('fire'), idempotencyKey: 'fire-alone' }),
    ).rejects.toMatchObject({ status: 422, code: 'estimate_reverted' })

    const arm = await relay(client, {
      signerId,
      chainId: anvil.chainId,
      to: target,
      data: call('arm'),
      idempotencyKey: 'arm',
    })
    const fire = await relay(client, {
      signerId,
      chainId: anvil.chainId,
      to: target,
      data: call('fire'),
      gasLimit: 100_000n,
      dependsOn: arm.txId,
      idempotencyKey: 'fire',
    })
    await drain()
    expect(await record(arm.txId)).toMatchObject({ status: 'submitted', nonce: 0 })
    expect((await record(fire.txId)).nonce).toBeUndefined()

    await sweep()
    await anvil.mine(4)
    // confirms arm; a second sweep covers the index listing fire before arm
    await sweep()
    await sweep()
    expect((await record(arm.txId)).status).toBe('confirmed')
    await drain()
    await sweep()
    expect(await getTx(client, fire.txId)).toMatchObject({
      status: 'mined',
      nonce: 1,
      receiptStatus: 'success',
      dependsOn: arm.txId,
    })
  })

  it('reconciles the nonce on a cold start after the key was used elsewhere', async () => {
    await anvil.sendExternal(privateKey)
    const tx = await relayPing(9n)
    await drain()
    await sweep()
    expect(await record(tx.txId)).toMatchObject({ status: 'mined', nonce: 1 })
  })

  it('recovers from nonce too low when a warm signer missed an outside transaction', async () => {
    const first = await relayPing(10n)
    await drain()
    await anvil.sendExternal(privateKey)
    const second = await relayPing(11n)
    await drain()
    await sweep()
    expect(await record(first.txId)).toMatchObject({ status: 'mined', nonce: 0 })
    expect(await record(second.txId)).toMatchObject({ status: 'mined', nonce: 2 })
  })
})
