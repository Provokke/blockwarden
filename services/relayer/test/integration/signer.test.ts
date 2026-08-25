import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { keccak256, parseTransaction, type LocalAccount } from 'viem'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { processTx, type SignerDeps } from '../../src/signer.js'
import { RelayerStore } from '../../src/store.js'
import { FakeChain } from '../helpers/fake-chain.js'
import { CHAIN_ID, localAccount, queuedTx, RecordingQueue, signerRecord } from '../helpers/fixtures.js'

const NOW = new Date('2026-09-17T12:00:00.000Z')

describe('processTx', () => {
  let dynamo: Dynamo
  let account: LocalAccount
  let store: RelayerStore
  let chain: FakeChain
  let queue: RecordingQueue
  let deps: SignerDeps
  let logs: string[]

  beforeAll(async () => {
    dynamo = await startDynamo()
    account = await localAccount()
  })

  afterAll(async () => {
    await dynamo?.stop()
  })

  beforeEach(async () => {
    store = new RelayerStore(dynamo.doc, await dynamo.newTable())
    chain = new FakeChain(CHAIN_ID)
    queue = new RecordingQueue()
    logs = []
    let ids = 0
    await store.putSigner(signerRecord())
    deps = {
      store,
      chainFor: (chainId) => (chainId === CHAIN_ID ? chain : undefined),
      accountFor: async () => account,
      queue,
      now: () => NOW,
      newTxId: () => `filler-${++ids}`,
      reconciled: new Set(),
      log: (message) => logs.push(message),
    }
  })

  const create = async (overrides = {}) => {
    const tx = queuedTx(account.address, overrides)
    await store.createTx(tx, { day: '2026-09-17', costGwei: 1, capGwei: 10 ** 9 }, NOW.getTime())
    return tx
  }

  it('reconciles the nonce, signs with clamped fees, stores the bytes and submits', async () => {
    chain.nonces.pending = 7
    // above the policy cap of 100 gwei, so the fee must be clamped
    chain.fees = { maxFeePerGas: 150_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n }
    const tx = await create()

    expect(await processTx(deps, tx.txId)).toBe('submitted')
    const stored = (await store.getTx(tx.txId))!
    expect(stored).toMatchObject({ status: 'submitted', nonce: 7 })
    expect(stored.history.map((h) => h.status)).toEqual(['queued', 'submitted'])
    expect(stored.attempts).toHaveLength(1)
    const [attempt] = stored.attempts
    expect(chain.sent).toEqual([attempt!.raw])
    expect(attempt!.hash).toBe(keccak256(attempt!.raw))
    const parsed = parseTransaction(attempt!.raw)
    expect(parsed).toMatchObject({
      chainId: CHAIN_ID,
      nonce: 7,
      to: tx.to.toLowerCase(),
      gas: 60_000n,
      maxFeePerGas: 100_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    })
    expect(deps.reconciled).toEqual(new Set([`billing#${CHAIN_ID}`]))
  })

  it('reconciles once per container, then counts nonces locally', async () => {
    const first = await create()
    const second = await create()
    await processTx(deps, first.txId)
    chain.nonces.pending = 0
    await processTx(deps, second.txId)
    expect(chain.calls.filter((c) => c === 'getNonce:pending')).toHaveLength(1)
    expect((await store.getTx(second.txId))?.nonce).toBe(1)
  })

  it('resends the stored bytes after a crash between saving the attempt and sending it', async () => {
    const tx = await create()
    // the first run dies inside send, after the attempt was saved
    chain.send = async () => {
      throw new Error('Lambda timed out')
    }
    await expect(processTx(deps, tx.txId)).rejects.toThrow('Lambda timed out')
    const crashed = (await store.getTx(tx.txId))!
    expect(crashed).toMatchObject({ status: 'queued', nonce: 0 })

    const resent: string[] = []
    chain.send = async (raw) => {
      resent.push(raw)
      return { kind: 'accepted' }
    }
    expect(await processTx(deps, tx.txId)).toBe('submitted')
    expect(resent).toEqual([crashed.attempts[0]!.raw])
    expect((await store.getTx(tx.txId))?.attempts).toHaveLength(1)
  })

  it.each(['already-known', 'unknown'] as const)('treats %s as submitted', async (kind) => {
    const tx = await create()
    chain.sendOutcomes = [kind === 'unknown' ? { kind, message: 'timeout' } : { kind }]
    expect(await processTx(deps, tx.txId)).toBe('submitted')
    expect((await store.getTx(tx.txId))?.status).toBe('submitted')
  })

  it('marks an underpriced first signature for replacement', async () => {
    const tx = await create()
    chain.sendOutcomes = [{ kind: 'underpriced', message: 'max fee per gas less than block base fee' }]
    expect(await processTx(deps, tx.txId)).toBe('submitted')
    const stored = (await store.getTx(tx.txId))!
    expect(stored).toMatchObject({ status: 'submitted', needsBump: true })
    expect(stored.attempts[0]!.rejected).toContain('base fee')
  })

  it('pauses the signer on insufficient funds and leaves the transaction queued with its nonce', async () => {
    const tx = await create({ value: '5' })
    chain.sendOutcomes = [{ kind: 'insufficient-funds', message: 'insufficient funds for gas * price + value' }]
    expect(await processTx(deps, tx.txId)).toBe('paused')
    const stored = (await store.getTx(tx.txId))!
    expect(stored).toMatchObject({ status: 'queued', nonce: 0 })
    const pause = await store.getPause('billing', CHAIN_ID)
    // value plus gas limit times the signed fee cap
    expect(pause).toMatchObject({ address: account.address, requiredWei: String(5n + 60_000n * 2_000_000_000n) })

    // while paused, a delivery of the next transaction does nothing
    const next = await create()
    expect(await processTx(deps, next.txId)).toBe('paused')
    expect((await store.getTx(next.txId))?.nonce).toBeUndefined()
    expect(chain.sent).toHaveLength(1)
  })

  it('checks for a receipt on nonce too low, and submits when one of its hashes was mined', async () => {
    const tx = await create()
    chain.send = async (raw) => {
      chain.mine(keccak256(raw))
      return { kind: 'nonce-too-low', message: 'nonce too low' }
    }
    expect(await processTx(deps, tx.txId)).toBe('submitted')
    expect((await store.getTx(tx.txId))?.nonce).toBe(0)
  })

  it('takes a fresh nonce after nonce too low with no receipt, reconciling again', async () => {
    const tx = await create()
    chain.sendOutcomes = [{ kind: 'nonce-too-low', message: 'nonce too low' }]
    let reads = 0
    chain.getNonce = async () => (reads++ === 0 ? 0 : 3)
    expect(await processTx(deps, tx.txId)).toBe('submitted')
    const stored = (await store.getTx(tx.txId))!
    expect(stored.nonce).toBe(3)
    expect(stored.attempts).toHaveLength(1)
    expect(parseTransaction(stored.attempts[0]!.raw).nonce).toBe(3)
    expect(chain.sent).toHaveLength(2)
  })

  it('gives up after repeated nonce too low so SQS retries later', async () => {
    const tx = await create()
    chain.sendOutcomes = Array.from({ length: 5 }, () => ({ kind: 'nonce-too-low', message: 'nonce too low' }) as const)
    await expect(processTx(deps, tx.txId)).rejects.toThrow(/kept hitting nonce too low/)
    expect(chain.sent).toHaveLength(3)
  })

  it('fails a refused transaction and queues a filler at the same nonce', async () => {
    chain.nonces.pending = 4
    chain.gas = 21_000n
    const tx = await create()
    chain.sendOutcomes = [{ kind: 'rejected', message: 'intrinsic gas too low' }]
    expect(await processTx(deps, tx.txId)).toBe('failed')

    const failed = (await store.getTx(tx.txId))!
    expect(failed).toMatchObject({ status: 'failed', error: 'intrinsic gas too low', fillerTxId: 'filler-1', nonce: 4 })
    expect(failed.attempts[0]!.rejected).toBe('intrinsic gas too low')
    const filler = (await store.getTx('filler-1'))!
    expect(filler).toMatchObject({
      kind: 'filler',
      status: 'queued',
      nonce: 4,
      to: account.address,
      from: account.address,
      value: '0',
      data: '0x',
      gasLimit: '25200',
      fillsTxId: tx.txId,
    })
    expect(queue.sent).toEqual([{ txId: 'filler-1', enqueues: 1 }])

    // the filler keeps its preassigned nonce when the signer processes it
    expect(await processTx(deps, 'filler-1')).toBe('submitted')
    expect(parseTransaction((await store.getTx('filler-1'))!.attempts[0]!.raw)).toMatchObject({
      nonce: 4,
      to: account.address.toLowerCase(),
    })
    // viem leaves a zero value out of the parsed transaction
    expect(parseTransaction((await store.getTx('filler-1'))!.attempts[0]!.raw).value).toBeUndefined()
  })

  it('fails a refused filler without creating another', async () => {
    const filler = await create({ kind: 'filler', nonce: 2 })
    chain.sendOutcomes = [{ kind: 'rejected', message: 'invalid chain id' }]
    expect(await processTx(deps, filler.txId)).toBe('failed')
    expect((await store.getTx(filler.txId))?.status).toBe('failed')
    expect(queue.sent).toEqual([])
    expect(logs).toContain('filler refused; the nonce stays open')
  })

  it('skips a transaction that is missing or no longer queued', async () => {
    expect(await processTx(deps, 'nope')).toBe('missing')
    const tx = await create({ status: 'submitted' })
    expect(await processTx(deps, tx.txId)).toBe('skipped')
    expect(chain.sent).toEqual([])
  })

  it('lets a signing failure propagate with the nonce kept on the transaction', async () => {
    const tx = await create()
    deps.accountFor = async () => ({
      ...account,
      signTransaction: () => Promise.reject(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })),
    })
    await expect(processTx(deps, tx.txId)).rejects.toThrow('Rate exceeded')
    expect(await store.getTx(tx.txId)).toMatchObject({ status: 'queued', nonce: 0, attempts: [] })
    deps.accountFor = async () => account
    expect(await processTx(deps, tx.txId)).toBe('submitted')
    expect((await store.getTx(tx.txId))?.nonce).toBe(0)
  })
})
