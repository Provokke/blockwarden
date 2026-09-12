import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { keccak256, parseTransaction, type LocalAccount } from 'viem'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEADLINE_MARGIN_MS } from '../../src/batch.js'
import { EstimateError } from '../../src/chain.js'
import { MAX_ABANDONED_ATTEMPTS, processTx, type SignerDeps } from '../../src/signer.js'
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
  let levels: Record<string, string | undefined>

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
    levels = {}
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
      log: (message, _data, level) => {
        logs.push(message)
        levels[message] = level
      },
    }
  })

  // counts KMS signatures, so a test can prove bytes were resent rather than signed again
  const countSignatures = () => {
    const counter = { signatures: 0 }
    deps.accountFor = async () => ({
      ...account,
      signTransaction: (...args: Parameters<LocalAccount['signTransaction']>) => {
        counter.signatures++
        return account.signTransaction(...args)
      },
    })
    return counter
  }

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
    expect(levels['signer paused: insufficient funds']).toBe('warn')
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
    // the refused signature at nonce 0 is kept, apart from the attempts the sweeper checks
    expect(stored.abandonedAttempts).toHaveLength(1)
    expect(stored.abandonedAttempts![0]).toMatchObject({
      hash: keccak256(chain.sent[0]!),
      raw: '0x',
      nonce: 0,
      rejected: 'nonce too low',
    })
  })

  it('gives the message back instead of sending at a fresh nonce when the batch deadline is near', async () => {
    const tx = await create()
    chain.sendOutcomes = [{ kind: 'nonce-too-low', message: 'nonce too low' }]
    await expect(processTx(deps, tx.txId, () => DEADLINE_MARGIN_MS - 1)).rejects.toThrow(/too little time/)
    const stored = (await store.getTx(tx.txId))!
    // given up and saved first, so the next delivery takes a fresh nonce
    expect(stored).toMatchObject({ status: 'queued', attempts: [] })
    expect(stored.nonce).toBeUndefined()
    expect(stored.abandonedAttempts).toHaveLength(1)
    expect(chain.sent).toHaveLength(1)

    chain.nonces.pending = 1
    expect(await processTx(deps, tx.txId, () => DEADLINE_MARGIN_MS)).toBe('submitted')
    expect(chain.sent).toHaveLength(2)
  })

  it('leaves a redelivered transaction to the sweeper on nonce too low instead of signing at a new nonce', async () => {
    const tx = await create()
    // the first run's send reached the node, then the run died before recording it
    chain.send = async (raw) => {
      chain.sent.push(raw)
      throw new Error('Lambda timed out')
    }
    await expect(processTx(deps, tx.txId)).rejects.toThrow('Lambda timed out')
    const crashed = (await store.getTx(tx.txId))!
    delete (chain as { send?: unknown }).send

    // the transaction was mined, but the node answering the receipt read lags behind
    const counter = countSignatures()
    chain.sendOutcomes = [{ kind: 'nonce-too-low', message: 'nonce too low' }]
    expect(await processTx(deps, tx.txId)).toBe('submitted')
    const stored = (await store.getTx(tx.txId))!
    expect(stored).toMatchObject({ status: 'submitted', nonce: 0 })
    expect(stored.attempts).toEqual(crashed.attempts)
    expect(stored.abandonedAttempts).toBeUndefined()
    expect(counter.signatures).toBe(0)
    expect(chain.sent).toEqual([crashed.attempts[0]!.raw, crashed.attempts[0]!.raw])
    expect(await store.getNextNonce('billing', CHAIN_ID)).toBe(1)
    expect(levels['nonce too low on a nonce sent before; left to the sweeper']).toBe('warn')
  })

  it('resends the same bytes when the save after an accepted send conflicts', async () => {
    const tx = await create()
    const counter = countSignatures()
    const realSave = store.saveTx.bind(store)
    store.saveTx = async (next, at) => {
      if (chain.sent.length === 1 && next.status === 'submitted') {
        // another writer moves the version first, so this save loses
        await realSave((await store.getTx(tx.txId))!, at)
      }
      return realSave(next, at)
    }
    await expect(processTx(deps, tx.txId)).rejects.toMatchObject({ name: 'TxConflictError' })
    store.saveTx = realSave
    const first = (await store.getTx(tx.txId))!
    expect(first).toMatchObject({ status: 'queued', nonce: 0 })

    chain.sendOutcomes = [{ kind: 'already-known' }]
    expect(await processTx(deps, tx.txId)).toBe('submitted')
    const stored = (await store.getTx(tx.txId))!
    expect(stored.attempts).toEqual(first.attempts.map((a) => ({ ...a, acceptedAt: NOW.getTime() })))
    expect(chain.sent).toEqual([first.attempts[0]!.raw, first.attempts[0]!.raw])
    expect(counter.signatures).toBe(1)
  })

  it('gives up after repeated nonce too low so SQS retries later', async () => {
    const tx = await create()
    chain.sendOutcomes = Array.from({ length: 5 }, () => ({ kind: 'nonce-too-low', message: 'nonce too low' }) as const)
    await expect(processTx(deps, tx.txId)).rejects.toThrow(/kept hitting nonce too low/)
    expect(chain.sent).toHaveLength(3)
    // it holds the third nonce with the signature it last sent, and keeps the two it gave up
    const held = (await store.getTx(tx.txId))!
    expect(held).toMatchObject({ status: 'queued', nonce: 2 })
    expect(held.attempts.map((a) => a.raw)).toEqual([chain.sent[2]])
    expect(held.abandonedAttempts?.map((a) => a.hash)).toEqual([keccak256(chain.sent[0]!), keccak256(chain.sent[1]!)])

    // the redelivery did not take that nonce, so it hands the transaction to the sweeper rather than throwing again
    const counter = countSignatures()
    expect(await processTx(deps, tx.txId)).toBe('submitted')
    const settled = (await store.getTx(tx.txId))!
    expect(settled).toMatchObject({ status: 'submitted', nonce: 2 })
    expect(settled.attempts).toEqual(held.attempts)
    expect(chain.sent[3]).toBe(held.attempts[0]!.raw)
    expect(counter.signatures).toBe(0)
  })

  it(`keeps only the newest ${MAX_ABANDONED_ATTEMPTS} abandoned attempts across runs, without their bytes`, async () => {
    const tx = await create()
    chain.sendOutcomes = Array.from({ length: 9 }, () => ({ kind: 'nonce-too-low', message: 'nonce too low' }) as const)
    // three runs that each give up two nonces; between them the transaction is back to queued with no nonce
    for (let run = 0; run < 3; run++) {
      await expect(processTx(deps, tx.txId)).rejects.toThrow(/kept hitting nonce too low/)
      const { nonce: _nonce, ...held } = (await store.getTx(tx.txId))!
      await store.saveTx({ ...held, attempts: [] }, NOW.toISOString())
    }
    const stored = (await store.getTx(tx.txId))!
    expect(chain.sent).toHaveLength(9)
    expect(stored.abandonedAttempts).toHaveLength(MAX_ABANDONED_ATTEMPTS)
    expect(stored.abandonedAttempts!.every((a) => a.raw === '0x')).toBe(true)
    // the two dropped are the first run's; the run's last send held its nonce and was never abandoned
    const abandonedSends = chain.sent.filter((_, i) => i % 3 !== 2)
    expect(stored.abandonedAttempts!.map((a) => a.hash)).toEqual(
      abandonedSends.slice(-MAX_ABANDONED_ATTEMPTS).map((raw) => keccak256(raw)),
    )
    expect(stored.abandonedAttempts!.map((a) => a.nonce)).toEqual(
      abandonedSends.slice(-MAX_ABANDONED_ATTEMPTS).map((raw) => parseTransaction(raw).nonce),
    )
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
    expect(failed.attempts[0]!.acceptedAt).toBeUndefined()
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

  it('records when a node took the first send, or may have', async () => {
    for (const outcome of [
      { kind: 'accepted' },
      { kind: 'already-known' },
      { kind: 'unknown', message: 'timed out' },
    ] as const) {
      const tx = await create()
      chain.sendOutcomes = [outcome]
      expect(await processTx(deps, tx.txId)).toBe('submitted')
      expect((await store.getTx(tx.txId))!.attempts[0]!.acceptedAt).toBe(NOW.getTime())
    }
  })

  it('fails a refused filler without creating another', async () => {
    const filler = await create({ kind: 'filler', nonce: 2 })
    chain.sendOutcomes = [{ kind: 'rejected', message: 'invalid chain id' }]
    expect(await processTx(deps, filler.txId)).toBe('failed')
    expect((await store.getTx(filler.txId))?.status).toBe('failed')
    expect(queue.sent).toEqual([])
    expect(logs).toContain('filler refused; the nonce stays open')
    expect(levels['filler refused; the nonce stays open']).toBe('warn')
  })

  it('leaves a filler whose nonce is already used to the sweeper, without taking another nonce', async () => {
    const filler = await create({ kind: 'filler', nonce: 2 })
    chain.sendOutcomes = [{ kind: 'nonce-too-low', message: 'nonce too low' }]
    expect(await processTx(deps, filler.txId)).toBe('submitted')
    const stored = (await store.getTx(filler.txId))!
    expect(stored).toMatchObject({ status: 'submitted', nonce: 2 })
    expect(stored.attempts).toHaveLength(1)
    expect(chain.sent).toEqual([stored.attempts[0]!.raw])
    expect(await store.getNextNonce('billing', CHAIN_ID)).toBeUndefined()
    expect(queue.sent).toEqual([])
  })

  it('skips a transaction that is missing or no longer queued', async () => {
    expect(await processTx(deps, 'nope')).toBe('missing')
    const tx = await create({ status: 'submitted' })
    expect(await processTx(deps, tx.txId)).toBe('skipped')
    expect(chain.sent).toEqual([])
  })

  describe('a dependent transaction', () => {
    const settle = async (
      tx: Awaited<ReturnType<typeof create>>,
      status: 'confirmed' | 'failed',
      receipt: 'success' | 'reverted' = 'success',
    ) =>
      store.saveTx(
        {
          ...tx,
          status,
          ...(status === 'confirmed'
            ? {
                mined: {
                  hash: `0x${'1'.repeat(64)}`,
                  blockNumber: 1,
                  blockHash: `0x${'2'.repeat(64)}`,
                  status: receipt,
                },
              }
            : {}),
        },
        'x',
      )

    it('waits without a nonce while its dependency is unsettled, then estimates and sends', async () => {
      const dependency = await create({ status: 'mined' })
      const tx = await create({ dependsOn: dependency.txId })
      expect(await processTx(deps, tx.txId)).toBe('waiting')
      expect((await store.getTx(tx.txId))?.nonce).toBeUndefined()
      expect(chain.sent).toEqual([])

      await settle(dependency, 'confirmed')
      expect(await processTx(deps, tx.txId)).toBe('submitted')
      expect(chain.calls).toContain('estimateGas')
      expect((await store.getTx(tx.txId))?.nonce).toBe(0)
    })

    it.each([
      ['failed', 'success'],
      ['confirmed', 'reverted'],
    ] as const)('fails without taking a nonce when its dependency is %s with receipt %s', async (status, receipt) => {
      const dependency = await create()
      await settle(dependency, status, receipt)
      const tx = await create({ dependsOn: dependency.txId })
      expect(await processTx(deps, tx.txId)).toBe('failed')
      expect(await store.getTx(tx.txId)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('did not succeed'),
      })
      expect(await store.getNextNonce('billing', CHAIN_ID)).toBeUndefined()
      expect(queue.sent).toEqual([])
    })

    it('fails without taking a nonce when the call still reverts after the dependency', async () => {
      const dependency = await create()
      await settle(dependency, 'confirmed')
      const tx = await create({ dependsOn: dependency.txId })
      chain.estimateFailure = new EstimateError('reverted', 'eth_estimateGas reverted', '0xdeadbeef')
      expect(await processTx(deps, tx.txId)).toBe('failed')
      expect((await store.getTx(tx.txId))?.error).toContain('0xdeadbeef')
      expect(await store.getNextNonce('billing', CHAIN_ID)).toBeUndefined()
    })

    it('fails without taking a nonce when its dependency was cancelled', async () => {
      const dependency = await create()
      await store.saveTx({ ...dependency, status: 'cancelled' }, 'x')
      const tx = await create({ dependsOn: dependency.txId })
      expect(await processTx(deps, tx.txId)).toBe('failed')
      expect(await store.getTx(tx.txId)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('did not succeed'),
      })
      expect(await store.getNextNonce('billing', CHAIN_ID)).toBeUndefined()
      expect(queue.sent).toEqual([])
    })

    it('fails without taking a nonce when its dependency record no longer exists', async () => {
      const tx = await create({ dependsOn: 'no-such-tx' })
      expect(await processTx(deps, tx.txId)).toBe('failed')
      expect(await store.getTx(tx.txId)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('did not succeed'),
      })
      expect(await store.getNextNonce('billing', CHAIN_ID)).toBeUndefined()
      expect(queue.sent).toEqual([])
    })

    it('fails without taking a nonce when the node refuses the call outright, not with a revert', async () => {
      const dependency = await create()
      await settle(dependency, 'confirmed')
      const tx = await create({ dependsOn: dependency.txId })
      chain.estimateFailure = new EstimateError('failed', 'gas required exceeds allowance')
      expect(await processTx(deps, tx.txId)).toBe('failed')
      expect((await store.getTx(tx.txId))?.error).toContain('gas required exceeds allowance')
      expect(await store.getNextNonce('billing', CHAIN_ID)).toBeUndefined()
      expect(queue.sent).toEqual([])
    })

    it('lets an RPC failure during that estimate propagate for a retry', async () => {
      const dependency = await create()
      await settle(dependency, 'confirmed')
      const tx = await create({ dependsOn: dependency.txId })
      chain.estimateFailure = new EstimateError('unavailable', 'down')
      await expect(processTx(deps, tx.txId)).rejects.toThrow('down')
      expect((await store.getTx(tx.txId))?.status).toBe('queued')
    })

    it('warns but still sends when the caller-set gasLimit is below the post-dependency estimate', async () => {
      const dependency = await create()
      await settle(dependency, 'confirmed')
      chain.gas = 90_000n
      const tx = await create({ dependsOn: dependency.txId, gasLimit: '60000' })
      expect(await processTx(deps, tx.txId)).toBe('submitted')
      expect((await store.getTx(tx.txId))?.nonce).toBe(0)
      expect(logs).toContain('dependent transaction gas limit is below the estimate')
      expect(levels['dependent transaction gas limit is below the estimate']).toBe('warn')
    })
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
