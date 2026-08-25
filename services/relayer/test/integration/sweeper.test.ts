import { isAcceptedReplacement } from '@blockwarden/core'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { keccak256, parseTransaction, type Hex, type LocalAccount } from 'viem'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Attempt, TxRecord } from '../../src/records.js'
import { signAttempt } from '../../src/sign.js'
import { RelayerStore } from '../../src/store.js'
import { MAX_ATTEMPTS, sweepChain, type SweeperDeps } from '../../src/sweeper.js'
import { FakeChain } from '../helpers/fake-chain.js'
import { CHAIN_ID, localAccount, queuedTx, RecordingQueue, signerRecord } from '../helpers/fixtures.js'

const START = Date.parse('2026-09-17T12:00:00.000Z')
const GWEI = 1_000_000_000n
const FAR = Number.MAX_SAFE_INTEGER

describe('sweepChain', () => {
  let dynamo: Dynamo
  let account: LocalAccount
  let store: RelayerStore
  let chain: FakeChain
  let queue: RecordingQueue
  let deps: SweeperDeps
  let nowMs: number
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
    nowMs = START
    logs = []
    await store.putSigner(signerRecord())
    deps = {
      store,
      chain,
      settings: { chainId: CHAIN_ID, confirmations: 5, stuckAfterMs: 90_000 },
      accountFor: async () => account,
      queue,
      now: () => new Date(nowMs),
      requeueAfterMs: 600_000,
      log: (message) => logs.push(message),
    }
  })

  const attempt = (tx: TxRecord, fee: bigint, tip: bigint, signedAt = START) =>
    signAttempt(account, tx, { maxFeePerGas: fee, maxPriorityFeePerGas: tip }, signedAt)

  // a transaction as the signer leaves it: nonce taken, one attempt signed and sent
  const submitted = async (overrides: Partial<TxRecord> = {}, fees: [bigint, bigint] = [2n * GWEI, 1n * GWEI]) => {
    const base = queuedTx(account.address, { status: 'submitted', nonce: 3, ...overrides })
    const tx = { ...base, attempts: overrides.attempts ?? [await attempt(base, fees[0], fees[1])] }
    await store.createTx(tx, { day: '2026-09-17', costGwei: 1, capGwei: 10 ** 9 }, START)
    return tx
  }

  const reload = async (tx: TxRecord) => (await store.getTx(tx.txId))!

  describe('receipts and confirmations', () => {
    it('marks a mined transaction, then confirms it once the depth is reached', async () => {
      const tx = await submitted()
      chain.nonces.latest = 4
      chain.head = 100
      const receipt = chain.mine(tx.attempts[0]!.hash, 97, 'reverted')

      expect(await sweepChain(deps, FAR)).toMatchObject({ mined: 1, confirmed: 0 })
      expect(await reload(tx)).toMatchObject({ status: 'mined', mined: receipt })

      chain.head = 101
      expect(await sweepChain(deps, FAR)).toMatchObject({ confirmed: 1 })
      const confirmed = await reload(tx)
      expect(confirmed.status).toBe('confirmed')
      expect(confirmed.history.map((h) => h.status)).toEqual(['queued', 'mined', 'confirmed'])
      expect(await store.listPending(CHAIN_ID, 10)).toEqual([])
    })

    it('goes straight to confirmed when the receipt is already deep enough', async () => {
      const tx = await submitted()
      chain.head = 120
      chain.mine(tx.attempts[0]!.hash, 100)
      expect(await sweepChain(deps, FAR)).toMatchObject({ mined: 1, confirmed: 1 })
      expect((await reload(tx)).status).toBe('confirmed')
    })

    it('finds the receipt of an earlier attempt after a replacement', async () => {
      const base = queuedTx(account.address, { status: 'submitted', nonce: 3 })
      const first = await attempt(base, 2n * GWEI, 1n * GWEI)
      const second = await attempt(base, 3n * GWEI, 2n * GWEI)
      const tx = await submitted({ attempts: [first, second] })
      chain.mine(first.hash, 98)
      await sweepChain(deps, FAR)
      expect((await reload(tx)).mined?.hash).toBe(first.hash)
    })

    it('puts a reorged receipt back to submitted and rebroadcasts the mined bytes', async () => {
      const tx = await submitted()
      chain.mine(tx.attempts[0]!.hash, 99)
      await sweepChain(deps, FAR)
      expect((await reload(tx)).status).toBe('mined')

      chain.receipts.clear()
      expect(await sweepChain(deps, FAR)).toMatchObject({ reorged: 1 })
      const reorged = await reload(tx)
      expect(reorged.status).toBe('submitted')
      expect(reorged.mined).toBeUndefined()
      expect(chain.sent).toEqual([tx.attempts[0]!.raw])
    })

    it('treats a receipt that moved to another block as a reorg', async () => {
      const tx = await submitted()
      chain.mine(tx.attempts[0]!.hash, 99)
      await sweepChain(deps, FAR)
      chain.mine(tx.attempts[0]!.hash, 100)
      expect(await sweepChain(deps, FAR)).toMatchObject({ reorged: 1 })
      await sweepChain(deps, FAR)
      expect((await reload(tx)).mined?.blockNumber).toBe(100)
    })
  })

  describe('stuck transactions', () => {
    it('leaves a transaction alone before the stuck threshold, rebroadcasting only if the node lost it', async () => {
      const tx = await submitted()
      chain.nonces.latest = 3
      nowMs = START + 89_999
      chain.known.add(tx.attempts[0]!.hash)
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 0, rebroadcast: 0 })
      chain.known.clear()
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 0, rebroadcast: 1 })
      expect(chain.sent).toEqual([tx.attempts[0]!.raw])
    })

    it('replaces a stuck transaction at the same nonce with fees the node accepts', async () => {
      const tx = await submitted()
      chain.nonces.latest = 3
      chain.known.add(tx.attempts[0]!.hash)
      nowMs = START + 90_000
      chain.fees = { maxFeePerGas: 1n * GWEI, maxPriorityFeePerGas: 1n }

      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 1 })
      const replaced = await reload(tx)
      expect(replaced.attempts).toHaveLength(2)
      const next = replaced.attempts[1]!
      expect(chain.sent).toEqual([next.raw])
      const parsed = parseTransaction(next.raw)
      expect(parsed.nonce).toBe(3)
      expect(parsed.maxFeePerGas).toBe(2_250_000_000n)
      expect(parsed.maxPriorityFeePerGas).toBe(1_125_000_000n)
      expect(
        isAcceptedReplacement(
          { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: 1n * GWEI },
          { maxFeePerGas: parsed.maxFeePerGas!, maxPriorityFeePerGas: parsed.maxPriorityFeePerGas! },
        ),
      ).toBe(true)
    })

    it('replaces immediately when the signer marked the transaction underpriced', async () => {
      const tx = await submitted({ needsBump: true })
      chain.nonces.latest = 3
      nowMs = START + 1_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 1 })
      expect((await reload(tx)).needsBump).toBeUndefined()
    })

    it('does not replace while a lower nonce is still outstanding', async () => {
      const tx = await submitted()
      chain.nonces.latest = 2
      chain.known.add(tx.attempts[0]!.hash)
      nowMs = START + 10 * 60_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 0 })
      expect(chain.sent).toEqual([])
    })

    it('stops at the fee cap: flags the transaction once and rebroadcasts instead', async () => {
      // the policy cap is 100 gwei fee and 10 gwei tip; 95 gwei needs 104.5 to be replaced
      const tx = await submitted({}, [95n * GWEI, 5n * GWEI])
      chain.nonces.latest = 3
      nowMs = START + 90_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 0, feeCapReached: 1, rebroadcast: 1 })
      expect((await reload(tx)).feeCapReached).toBe(true)
      expect(chain.sent).toEqual([tx.attempts[0]!.raw])
      expect(logs).toEqual(['cannot replace: the fee cap or the attempt limit is reached'])

      await sweepChain(deps, FAR)
      expect(logs).toHaveLength(1)
    })

    it('stops replacing at the attempt limit', async () => {
      const base = queuedTx(account.address, { status: 'submitted', nonce: 3 })
      const attempts: Attempt[] = []
      for (let i = 0; i < MAX_ATTEMPTS; i++) attempts.push(await attempt(base, BigInt(i + 1) * GWEI, 1n + BigInt(i)))
      const tx = await submitted({ attempts })
      chain.nonces.latest = 3
      nowMs = START + 90_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 0, feeCapReached: 1 })
      expect((await reload(tx)).attempts).toHaveLength(MAX_ATTEMPTS)
    })

    it('records a refused replacement without failing, and marks an underpriced one for another try', async () => {
      const tx = await submitted()
      chain.nonces.latest = 3
      nowMs = START + 90_000
      chain.sendOutcomes = [{ kind: 'underpriced', message: 'replacement transaction underpriced' }]
      await sweepChain(deps, FAR)
      const first = await reload(tx)
      expect(first).toMatchObject({ status: 'submitted', needsBump: true })
      expect(first.attempts[1]!.rejected).toBe('replacement transaction underpriced')

      // the next replacement starts from the refused one, so the fees keep rising
      chain.sendOutcomes = [{ kind: 'rejected', message: 'exceeds block gas limit' }]
      await sweepChain(deps, FAR)
      const second = await reload(tx)
      expect(second.status).toBe('submitted')
      expect(second.needsBump).toBeUndefined()
      expect(BigInt(second.attempts[2]!.maxFeePerGas)).toBeGreaterThan(BigInt(second.attempts[1]!.maxFeePerGas))
      expect(second.attempts[2]!.rejected).toBe('exceeds block gas limit')
    })

    it('rebroadcasts the newest attempt the node did not refuse', async () => {
      const base = queuedTx(account.address, { status: 'submitted', nonce: 3 })
      const live = await attempt(base, 2n * GWEI, 1n * GWEI)
      const refused = {
        ...(await attempt(base, 3n * GWEI, 2n * GWEI)),
        rejected: 'replacement transaction underpriced',
      }
      await submitted({ attempts: [live, refused] })
      chain.nonces.latest = 3
      nowMs = START + 1_000
      await sweepChain(deps, FAR)
      expect(chain.sent).toEqual([live.raw])
    })
  })

  describe('a nonce used by someone else', () => {
    it('waits the confirmation depth, then fails the transaction without a filler', async () => {
      const tx = await submitted()
      chain.nonces.latest = 4
      chain.head = 200
      await sweepChain(deps, FAR)
      expect(await reload(tx)).toMatchObject({ status: 'submitted', nonceUsedAtBlock: 200 })
      chain.head = 204
      await sweepChain(deps, FAR)
      expect((await reload(tx)).status).toBe('submitted')
      chain.head = 205
      expect(await sweepChain(deps, FAR)).toMatchObject({ failed: 1 })
      expect(await reload(tx)).toMatchObject({ status: 'failed', error: expect.stringContaining('did not send') })
      expect(queue.sent).toEqual([])
    })

    it('clears the wait when a receipt shows up after all', async () => {
      const tx = await submitted()
      chain.nonces.latest = 4
      await sweepChain(deps, FAR)
      chain.mine(tx.attempts[0]!.hash, 99)
      await sweepChain(deps, FAR)
      expect((await reload(tx)).nonceUsedAtBlock).toBeUndefined()
    })
  })

  describe('queued transactions', () => {
    it('requeues a transaction that sat past the threshold, with a new deduplication count', async () => {
      const tx = queuedTx(account.address)
      await store.createTx(tx, { day: '2026-09-17', costGwei: 1, capGwei: 10 ** 9 }, START)
      nowMs = tx.enqueuedAt + 599_999
      expect(await sweepChain(deps, FAR)).toMatchObject({ requeued: 0 })
      nowMs = tx.enqueuedAt + 600_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ requeued: 1 })
      expect(queue.sent).toEqual([{ txId: tx.txId, enqueues: 2 }])
      expect(await reload(tx)).toMatchObject({ enqueues: 2, enqueuedAt: nowMs })
    })

    it('keeps a paused signer queued until its balance covers the paused transaction, then requeues in nonce order', async () => {
      const later = queuedTx(account.address, { createdAt: '2026-09-17T00:00:01.000Z' })
      const withNonce = queuedTx(account.address, { nonce: 6, createdAt: '2026-09-17T00:00:02.000Z' })
      for (const tx of [later, withNonce]) {
        await store.createTx(tx, { day: '2026-09-17', costGwei: 1, capGwei: 10 ** 9 }, START)
      }
      await store.pause({
        signerId: 'billing',
        chainId: CHAIN_ID,
        address: account.address,
        requiredWei: '1000',
        since: 'x',
      })
      nowMs = START + 3_600_000
      chain.balances.set(account.address.toLowerCase(), 999n)
      expect(await sweepChain(deps, FAR)).toMatchObject({ requeued: 0, resumed: 0 })

      chain.balances.set(account.address.toLowerCase(), 1000n)
      expect(await sweepChain(deps, FAR)).toMatchObject({ requeued: 2, resumed: 1 })
      expect(queue.sent.map((s) => s.txId)).toEqual([withNonce.txId, later.txId])
      expect(await store.getPause('billing', CHAIN_ID)).toBeUndefined()
    })
  })

  it('counts a conflicting write and carries on with the rest', async () => {
    const first = await submitted()
    const second = await submitted()
    chain.nonces.latest = 3
    chain.mine(first.attempts[0]!.hash, 99)
    chain.mine(second.attempts[0]!.hash, 99)
    // another writer bumps the first transaction's version after the sweep listed it
    const realGetBlockNumber = chain.getBlockNumber.bind(chain)
    chain.getBlockNumber = async () => {
      await store.saveTx(first, new Date().toISOString())
      return realGetBlockNumber()
    }
    expect(await sweepChain(deps, FAR)).toMatchObject({ conflicts: 1, mined: 1 })
    expect((await reload(second)).status).toBe('mined')
  })

  it('stops at the deadline and reports the oldest pending age', async () => {
    await submitted()
    const summary = await sweepChain(deps, 0)
    expect(summary.checked).toBe(0)
    nowMs = START + 42_000
    expect((await sweepChain(deps, 0)).oldestPendingSeconds).toBe(42 + 12 * 3600)
  })

  it('returns quickly with nothing pending', async () => {
    expect(await sweepChain(deps, FAR)).toMatchObject({ checked: 0, oldestPendingSeconds: 0 })
    expect(chain.calls).toEqual([])
  })

  // keeps the helper honest: a raw's hash is what the fake chain keys receipts by
  it('hashes attempts the way the chain does', async () => {
    const tx = await submitted()
    expect(tx.attempts[0]!.hash).toBe(keccak256(tx.attempts[0]!.raw as Hex))
  })
})
