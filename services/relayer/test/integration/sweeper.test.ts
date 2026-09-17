import { isAcceptedReplacement } from '@blockwarden/core'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { keccak256, parseTransaction, type Hex, type LocalAccount } from 'viem'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attempt, TxRecord } from '../../src/records.js'
import { signAttempt } from '../../src/sign.js'
import { processTx, type SignerDeps } from '../../src/signer.js'
import { RelayerStore } from '../../src/store.js'
import { MAX_ATTEMPTS, MAX_SIGNED_ATTEMPTS, sweepChain, type SweeperDeps } from '../../src/sweeper.js'
import { FakeChain, receiptAt } from '../helpers/fake-chain.js'
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
    nowMs = START
    logs = []
    levels = {}
    let ids = 0
    await store.putSigner(signerRecord())
    deps = {
      store,
      chain,
      settings: { chainId: CHAIN_ID, confirmations: 5, stuckAfterMs: 90_000 },
      accountFor: async () => account,
      queue,
      now: () => new Date(nowMs),
      requeueAfterMs: 600_000,
      newTxId: () => `filler-${++ids}`,
      log: (message, _data, level) => {
        logs.push(message)
        levels[message] = level
      },
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

    it('saves a replacement before sending it', async () => {
      const tx = await submitted()
      chain.nonces.latest = 3
      nowMs = START + 90_000
      let storedAtSend: TxRecord | undefined
      chain.onSend = async () => {
        storedAtSend = await reload(tx)
      }
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 1 })
      expect(storedAtSend!.attempts).toHaveLength(2)
      expect(storedAtSend!.attempts[1]!.raw).toBe(chain.sent[0])
    })

    it('does not count refused attempts towards the attempt limit', async () => {
      const base = queuedTx(account.address, { status: 'submitted', nonce: 3 })
      const attempts: Attempt[] = []
      for (let i = 0; i < MAX_ATTEMPTS + 4; i++) {
        const signed = await attempt(base, BigInt(i + 1) * GWEI, 1n + BigInt(i))
        attempts.push(i < MAX_ATTEMPTS - 1 ? signed : { ...signed, rejected: 'replacement transaction underpriced' })
      }
      const tx = await submitted({ attempts })
      chain.nonces.latest = 3
      nowMs = START + 90_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 1, feeCapReached: 0 })
      const replaced = await reload(tx)
      expect(replaced.attempts).toHaveLength(MAX_ATTEMPTS + 5)
      expect(chain.sent).toEqual([replaced.attempts.at(-1)!.raw])

      // that one was accepted, so the next replacement meets the limit
      nowMs += 90_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 0, feeCapReached: 1 })
    })

    it(`keeps the bytes of at most ${MAX_SIGNED_ATTEMPTS} attempts, taking them from the oldest refused ones`, async () => {
      const base = queuedTx(account.address, { status: 'submitted', nonce: 3 })
      const attempts: Attempt[] = []
      // live at 0 and 2..9, refused at 1 and from 10 on
      for (let i = 0; i < MAX_SIGNED_ATTEMPTS; i++) {
        const signed = await attempt(base, BigInt(i + 1) * GWEI, 1n + BigInt(i))
        attempts.push(i === 1 || i >= MAX_ATTEMPTS ? { ...signed, rejected: 'exceeds block gas limit' } : signed)
      }
      const tx = await submitted({ attempts })
      chain.nonces.latest = 3
      nowMs = START + 90_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 1 })
      const replaced = await reload(tx)
      expect(replaced.attempts).toHaveLength(MAX_SIGNED_ATTEMPTS + 1)
      expect(replaced.attempts.filter((a) => a.raw !== '0x')).toHaveLength(MAX_SIGNED_ATTEMPTS)
      expect(replaced.attempts[1]).toEqual({ ...attempts[1], raw: '0x' })
      expect(replaced.attempts.slice(0, -1).filter((_, i) => i !== 1)).toEqual(attempts.filter((_, i) => i !== 1))
    })

    it('pauses the signer when a replacement is refused for insufficient funds', async () => {
      const tx = await submitted()
      chain.nonces.latest = 3
      nowMs = START + 90_000
      chain.sendOutcomes = [{ kind: 'insufficient-funds', message: 'insufficient funds for gas * price + value' }]
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 1, failed: 0 })
      const stored = await reload(tx)
      const refused = stored.attempts[1]!
      expect(stored.status).toBe('submitted')
      expect(refused.rejected).toBe('insufficient funds for gas * price + value')
      expect(await store.getPause('billing', CHAIN_ID)).toEqual({
        signerId: 'billing',
        chainId: CHAIN_ID,
        address: account.address,
        requiredWei: (BigInt(tx.gasLimit) * BigInt(refused.maxFeePerGas)).toString(),
        since: new Date(nowMs).toISOString(),
      })
      expect(logs).toContain('signer paused: insufficient funds')
      expect(levels['signer paused: insufficient funds']).toBe('warn')
    })

    it('recovers a transaction whose every signature was refused once fees fall under the cap', async () => {
      const tx = queuedTx(account.address)
      await store.createTx(tx, { day: '2026-09-17', costGwei: 1, capGwei: 10 ** 9 }, START)
      const signerDeps: SignerDeps = {
        store,
        chainFor: () => chain,
        accountFor: async () => account,
        queue,
        now: () => new Date(nowMs),
        newTxId: () => 'filler',
        reconciled: new Set(),
        log: (message) => logs.push(message),
      }
      // the base fee is above the 100 gwei cap, so the signer's clamped first signature is refused
      chain.fees = { maxFeePerGas: 150n * GWEI, maxPriorityFeePerGas: 1n * GWEI }
      chain.sendOutcomes = [{ kind: 'underpriced', message: 'max fee per gas less than block base fee' }]
      expect(await processTx(signerDeps, tx.txId)).toBe('submitted')
      expect(chain.sent).toHaveLength(1)

      // still above the cap: nothing worth signing, and the attempt list does not grow
      for (let i = 0; i < 3; i++) {
        nowMs += 60_000
        await sweepChain(deps, FAR)
      }
      expect(chain.sent).toHaveLength(1)
      expect((await reload(tx)).attempts).toHaveLength(1)

      chain.fees = { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: 1n * GWEI }
      nowMs += 60_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 1 })
      const recovered = await reload(tx)
      expect(recovered.attempts).toHaveLength(2)
      expect(recovered.attempts[1]!.maxFeePerGas).toBe(String(2n * GWEI))
      expect(recovered.attempts[1]!.rejected).toBeUndefined()
      expect(chain.sent).toEqual([recovered.attempts[0]!.raw, recovered.attempts[1]!.raw])
      expect(recovered.needsBump).toBeUndefined()
      expect(recovered.feeCapReached).toBeUndefined()

      // accepted and known to the node: the next sweep leaves it alone
      chain.known.add(recovered.attempts[1]!.hash)
      nowMs += 60_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 0, rebroadcast: 0 })
      expect((await reload(tx)).attempts).toHaveLength(2)
    })

    it('recovers when a refused signature and its refused replacement at the cap leave nothing live', async () => {
      const base = queuedTx(account.address, { status: 'submitted', nonce: 3 })
      const refused = { ...(await attempt(base, 50n * GWEI, 1n * GWEI)), rejected: 'transaction underpriced' }
      const tx = await submitted({ attempts: [refused], needsBump: true })
      chain.nonces.latest = 3
      chain.fees = { maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 2n * GWEI }
      chain.sendOutcomes = [{ kind: 'underpriced', message: 'max fee per gas less than block base fee' }]
      nowMs = START + 60_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 1 })
      const both = await reload(tx)
      expect(both.attempts.map((a) => a.maxFeePerGas)).toEqual([String(50n * GWEI), String(100n * GWEI)])
      expect(both.attempts.every((a) => a.rejected !== undefined)).toBe(true)

      chain.fees = { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: 1n * GWEI }
      nowMs += 60_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 1 })
      const recovered = await reload(tx)
      expect(recovered.attempts).toHaveLength(3)
      expect(recovered.attempts[2]!.maxFeePerGas).toBe(String(2n * GWEI))
      expect(recovered.attempts[2]!.rejected).toBeUndefined()
      expect(chain.sent.at(-1)).toBe(recovered.attempts[2]!.raw)
      expect(recovered.needsBump).toBeUndefined()
      expect(recovered.feeCapReached).toBeUndefined()
    })

    it('fails the transaction when a fresh signature with nothing live is refused outright', async () => {
      chain.gas = 21_000n
      const base = queuedTx(account.address, { status: 'submitted', nonce: 3 })
      const refused = { ...(await attempt(base, 50n * GWEI, 1n * GWEI)), rejected: 'transaction underpriced' }
      const tx = await submitted({ attempts: [refused], needsBump: true })
      chain.nonces.latest = 3
      chain.sendOutcomes = [{ kind: 'rejected', message: 'exceeds block gas limit' }]
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 1, failed: 1 })
      expect(await reload(tx)).toMatchObject({ status: 'failed', fillerTxId: 'filler-1' })
      expect(queue.sent).toEqual([{ txId: 'filler-1', enqueues: 1 }])
    })

    it('clears the fee cap flag once a replacement is accepted', async () => {
      const tx = await submitted({ feeCapReached: true })
      chain.nonces.latest = 3
      chain.known.add(tx.attempts[0]!.hash)
      nowMs = START + 90_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ replaced: 1 })
      expect((await reload(tx)).feeCapReached).toBeUndefined()
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

  describe("the node's answer to a rebroadcast", () => {
    // not stuck, and the node has forgotten the transaction, so the sweep sends the same bytes again
    const lost = async (overrides: Partial<TxRecord> = {}) => {
      const tx = await submitted(overrides)
      chain.nonces.latest = 3
      nowMs = START + 1_000
      return tx
    }

    it('fails a transaction whose rebroadcast is refused outright, and queues a filler for its nonce', async () => {
      chain.gas = 21_000n
      const tx = await lost()
      chain.sendOutcomes = [{ kind: 'rejected', message: 'exceeds block gas limit' }]
      expect(await sweepChain(deps, FAR)).toMatchObject({ rebroadcast: 1, failed: 1 })
      const failed = await reload(tx)
      expect(failed).toMatchObject({ status: 'failed', error: 'exceeds block gas limit', fillerTxId: 'filler-1' })
      expect(failed.attempts[0]!.rejected).toBe('exceeds block gas limit')
      expect(await store.getTx('filler-1')).toMatchObject({
        kind: 'filler',
        status: 'queued',
        nonce: 3,
        from: account.address,
        to: account.address,
        gasLimit: '25200',
        fillsTxId: tx.txId,
      })
      expect(queue.sent).toEqual([{ txId: 'filler-1', enqueues: 1 }])
    })

    it('fails a refused filler rebroadcast without queuing another filler', async () => {
      const filler = await lost({ kind: 'filler' })
      chain.sendOutcomes = [{ kind: 'rejected', message: 'invalid chain id' }]
      expect(await sweepChain(deps, FAR)).toMatchObject({ failed: 1 })
      const failed = await reload(filler)
      expect(failed).toMatchObject({ status: 'failed', error: 'invalid chain id' })
      expect(failed.fillerTxId).toBeUndefined()
      expect(queue.sent).toEqual([])
    })

    it('pauses the signer when a rebroadcast meets insufficient funds', async () => {
      const tx = await lost()
      chain.sendOutcomes = [{ kind: 'insufficient-funds', message: 'insufficient funds for gas * price + value' }]
      expect(await sweepChain(deps, FAR)).toMatchObject({ rebroadcast: 1, failed: 0 })
      expect(await store.getPause('billing', CHAIN_ID)).toMatchObject({
        address: account.address,
        requiredWei: (BigInt(tx.gasLimit) * BigInt(tx.attempts[0]!.maxFeePerGas)).toString(),
      })
      expect((await reload(tx)).status).toBe('submitted')
      expect(levels['signer paused: insufficient funds']).toBe('warn')
    })

    it('marks an underpriced rebroadcast for replacement', async () => {
      const tx = await lost()
      chain.sendOutcomes = [{ kind: 'underpriced', message: 'max fee per gas less than block base fee' }]
      await sweepChain(deps, FAR)
      const stored = await reload(tx)
      expect(stored).toMatchObject({ status: 'submitted', needsBump: true })
      expect(stored.attempts[0]!.rejected).toBeUndefined()
    })

    it('fails a reorged transaction whose mined bytes are refused outright on the way back', async () => {
      const tx = await submitted()
      chain.mine(tx.attempts[0]!.hash, 99)
      await sweepChain(deps, FAR)
      chain.receipts.clear()
      chain.sendOutcomes = [{ kind: 'rejected', message: 'invalid sender' }]
      expect(await sweepChain(deps, FAR)).toMatchObject({ reorged: 1, failed: 1 })
      expect(await reload(tx)).toMatchObject({ status: 'failed', error: 'invalid sender', fillerTxId: 'filler-1' })
      expect(queue.sent).toEqual([{ txId: 'filler-1', enqueues: 1 }])
    })

    it('pauses the signer when a reorged transaction meets insufficient funds on the way back', async () => {
      const tx = await submitted()
      chain.mine(tx.attempts[0]!.hash, 99)
      await sweepChain(deps, FAR)
      chain.receipts.clear()
      chain.sendOutcomes = [{ kind: 'insufficient-funds', message: 'insufficient funds for gas * price + value' }]
      expect(await sweepChain(deps, FAR)).toMatchObject({ reorged: 1 })
      expect(await store.getPause('billing', CHAIN_ID)).toBeDefined()
      expect((await reload(tx)).status).toBe('submitted')
    })
  })

  describe('a nonce used by someone else', () => {
    const MIN_AGE = 600_000

    it('waits the confirmation depth and the minimum age, then fails the transaction without a filler', async () => {
      const tx = await submitted()
      chain.nonces.latest = 4
      chain.head = 200
      await sweepChain(deps, FAR)
      expect(await reload(tx)).toMatchObject({
        status: 'submitted',
        nonceUsedAtBlock: 200,
        nonceUsedAt: new Date(START).toISOString(),
      })
      nowMs = START + MIN_AGE
      chain.head = 204
      await sweepChain(deps, FAR)
      expect((await reload(tx)).status).toBe('submitted')
      chain.head = 205
      expect(await sweepChain(deps, FAR)).toMatchObject({ failed: 1 })
      expect(await reload(tx)).toMatchObject({ status: 'failed', error: expect.stringContaining('did not send') })
      expect(queue.sent).toEqual([])
    })

    it('does not fail before the minimum age, however many blocks pass', async () => {
      const tx = await submitted()
      chain.nonces.latest = 4
      chain.head = 200
      await sweepChain(deps, FAR)
      chain.head = 10_000
      nowMs = START + MIN_AGE - 1
      expect(await sweepChain(deps, FAR)).toMatchObject({ failed: 0 })
      expect((await reload(tx)).status).toBe('submitted')
    })

    it('takes the minimum age from the chain settings', async () => {
      const tx = await submitted()
      deps.settings = { ...deps.settings, nonceUsedMinAgeMs: 60_000 }
      chain.nonces.latest = 4
      await sweepChain(deps, FAR)
      chain.head += 5
      nowMs = START + 60_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ failed: 1 })
      expect((await reload(tx)).status).toBe('failed')
    })

    it('clears the wait when the nonce reads as unused again, and starts it afresh', async () => {
      const tx = await submitted()
      chain.nonces.latest = 4
      await sweepChain(deps, FAR)
      chain.nonces.latest = 3
      chain.known.add(tx.attempts[0]!.hash)
      await sweepChain(deps, FAR)
      const cleared = await reload(tx)
      expect(cleared.nonceUsedAtBlock).toBeUndefined()
      expect(cleared.nonceUsedAt).toBeUndefined()

      // an old marker would fail it here; a fresh one waits again
      chain.nonces.latest = 4
      chain.head += 10
      nowMs = START + MIN_AGE
      expect(await sweepChain(deps, FAR)).toMatchObject({ failed: 0 })
      expect(await reload(tx)).toMatchObject({ status: 'submitted', nonceUsedAt: new Date(nowMs).toISOString() })
    })

    it('clears the wait when a receipt shows up after all', async () => {
      const tx = await submitted()
      chain.nonces.latest = 4
      await sweepChain(deps, FAR)
      chain.mine(tx.attempts[0]!.hash, 99)
      await sweepChain(deps, FAR)
      const mined = await reload(tx)
      expect(mined.nonceUsedAtBlock).toBeUndefined()
      expect(mined.nonceUsedAt).toBeUndefined()
    })

    it('asks every RPC URL for a receipt before failing, and marks it mined when another one has it', async () => {
      const tx = await submitted()
      chain.nonces.latest = 4
      chain.head = 200
      await sweepChain(deps, FAR)
      // the URL the fallback reads from lags and answers null; the second one has the receipt
      chain.otherNodes = [{ receipts: new Map([[tx.attempts[0]!.hash, receiptAt(tx.attempts[0]!.hash, 180)]]) }]
      chain.head = 205
      nowMs = START + MIN_AGE
      expect(await sweepChain(deps, FAR)).toMatchObject({ failed: 0, mined: 1, confirmed: 1 })
      expect(await reload(tx)).toMatchObject({ status: 'confirmed', mined: { hash: tx.attempts[0]!.hash } })
    })

    it('does not fail on a sweep where one RPC URL errors', async () => {
      const tx = await submitted()
      chain.nonces.latest = 4
      chain.head = 200
      await sweepChain(deps, FAR)
      chain.otherNodes = [{ receipts: new Map(), failure: new Error('connect ECONNREFUSED') }]
      chain.head = 205
      nowMs = START + MIN_AGE
      expect(await sweepChain(deps, FAR)).toMatchObject({ failed: 0 })
      expect((await reload(tx)).status).toBe('submitted')

      chain.otherNodes = [{ receipts: new Map() }]
      expect(await sweepChain(deps, FAR)).toMatchObject({ failed: 1 })
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

    it('holds a dependent transaction until its dependency settles, then requeues it once', async () => {
      const dependency = await submitted()
      const tx = queuedTx(account.address, { dependsOn: dependency.txId })
      await store.createTx(tx, { day: '2026-09-17', costGwei: 1, capGwei: 10 ** 9 }, START)
      nowMs = START + 3_600_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ requeued: 0 })

      chain.head = 120
      chain.mine(dependency.attempts[0]!.hash, 100)
      // both were created in the same millisecond, so the index may list either first: two sweeps cover both orders
      await sweepChain(deps, FAR)
      expect((await reload(dependency)).status).toBe('confirmed')
      await sweepChain(deps, FAR)
      expect(queue.sent).toEqual([{ txId: tx.txId, enqueues: 2 }])
      // requeued after the dependency settled, so from here only the usual staleness rule applies
      nowMs += 60_000
      await sweepChain(deps, FAR)
      expect(queue.sent).toHaveLength(1)
    })

    it('requeues a dependent transaction whose dependency failed, so the signer can fail it', async () => {
      const dependency = await submitted()
      await store.saveTx({ ...dependency, status: 'failed' }, new Date(START + 1_000).toISOString())
      // enqueued just now, so only the settled dependency, not staleness, can send it back
      const tx = queuedTx(account.address, { dependsOn: dependency.txId, enqueuedAt: START })
      await store.createTx(tx, { day: '2026-09-17', costGwei: 1, capGwei: 10 ** 9 }, START)
      expect(await sweepChain(deps, FAR)).toMatchObject({ requeued: 1 })
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

  describe('a sweep that meets trouble', () => {
    const spend = { day: '2026-09-17', costGwei: 1, capGwei: 10 ** 9 }

    it('counts a transaction that throws as an error, logs it, and carries on with the next', async () => {
      const entries: { message: string; data?: Record<string, unknown>; level?: string }[] = []
      deps.log = (message, data, level) => entries.push({ message, data, level })
      const broken = await submitted({ createdAt: '2026-09-17T00:00:01.000Z' })
      const fine = await submitted({ nonce: 4, createdAt: '2026-09-17T00:00:02.000Z' })
      chain.head = 120
      chain.mine(broken.attempts[0]!.hash, 100)
      chain.mine(fine.attempts[0]!.hash, 100)
      const realGetReceipt = chain.getReceipt.bind(chain)
      chain.getReceipt = async (hash) => {
        if (hash === broken.attempts[0]!.hash) throw new Error('upstream went away')
        return realGetReceipt(hash)
      }
      expect(await sweepChain(deps, FAR)).toMatchObject({ checked: 2, errors: 1, confirmed: 1 })
      expect((await reload(broken)).status).toBe('submitted')
      expect((await reload(fine)).status).toBe('confirmed')
      expect(entries).toContainEqual({
        message: expect.any(String),
        data: { txId: broken.txId, error: 'upstream went away' },
        level: 'error',
      })
    })

    it('counts a transaction whose signer has a malformed policy as an error, and carries on', async () => {
      await store.putSigner(signerRecord({ signerId: 'broken', policy: { maxGasLimit: 'lots' } as never }))
      await submitted({ signerId: 'broken', createdAt: '2026-09-17T00:00:01.000Z' })
      const fine = await submitted({ nonce: 4, createdAt: '2026-09-17T00:00:02.000Z' })
      chain.head = 120
      chain.mine(fine.attempts[0]!.hash, 100)
      expect(await sweepChain(deps, FAR)).toMatchObject({ errors: 1, confirmed: 1 })
      expect((await reload(fine)).status).toBe('confirmed')
    })

    it('pages through every pending transaction in one sweep', async () => {
      deps.pageSize = 2
      const txs: TxRecord[] = []
      for (let i = 0; i < 5; i++) {
        const tx = queuedTx(account.address, { createdAt: `2026-09-17T00:00:0${i}.000Z` })
        await store.createTx(tx, spend, START)
        txs.push(tx)
      }
      nowMs = START + 3_600_000
      expect(await sweepChain(deps, FAR)).toMatchObject({ checked: 5, requeued: 5, oldestPendingSeconds: 13 * 3600 })
      expect(queue.sent.map((q) => q.txId).sort()).toEqual(txs.map((tx) => tx.txId).sort())
    })

    it("requeues a resumed signer's queued transactions that sit on a later page", async () => {
      deps.pageSize = 1
      // enqueued just now, so only the resume, not staleness, can send them back
      const first = queuedTx(account.address, { createdAt: '2026-09-17T00:00:01.000Z', enqueuedAt: START })
      const second = queuedTx(account.address, { createdAt: '2026-09-17T00:00:02.000Z', enqueuedAt: START })
      for (const tx of [first, second]) await store.createTx(tx, spend, START)
      await store.pause({
        signerId: 'billing',
        chainId: CHAIN_ID,
        address: account.address,
        requiredWei: '1',
        since: 'x',
      })
      chain.balances.set(account.address.toLowerCase(), 1n)
      expect(await sweepChain(deps, FAR)).toMatchObject({ resumed: 1, requeued: 2 })
      expect(queue.sent.map((q) => q.txId)).toEqual([first.txId, second.txId])
    })

    it("stops requeuing a resumed signer's queue at the deadline", async () => {
      const txs = [
        queuedTx(account.address, { createdAt: '2026-09-17T00:00:01.000Z', enqueuedAt: START }),
        queuedTx(account.address, { createdAt: '2026-09-17T00:00:02.000Z', enqueuedAt: START }),
      ]
      for (const tx of txs) await store.createTx(tx, spend, START)
      await store.pause({
        signerId: 'billing',
        chainId: CHAIN_ID,
        address: account.address,
        requiredWei: '1',
        since: 'x',
      })
      chain.balances.set(account.address.toLowerCase(), 1n)
      // the deadline passes while the first requeue is being sent
      const realNow = Date.now.bind(Date)
      let late = 0
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + late)
      const deadline = realNow() + 60_000
      const send = queue.send.bind(queue)
      queue.send = async (tx) => {
        await send(tx)
        late = 120_000
      }
      try {
        expect(await sweepChain(deps, deadline)).toMatchObject({ resumed: 1, requeued: 1 })
      } finally {
        clock.mockRestore()
      }
    })
  })

  it('settles a transaction the signer left behind on nonce too low once its receipt appears', async () => {
    const tx = queuedTx(account.address)
    await store.createTx(tx, { day: '2026-09-17', costGwei: 1, capGwei: 10 ** 9 }, START)
    const signerDeps: SignerDeps = {
      store,
      chainFor: () => chain,
      accountFor: async () => account,
      queue,
      now: () => new Date(nowMs),
      newTxId: () => 'filler',
      reconciled: new Set(),
      log: (message) => logs.push(message),
    }
    // the first run's send reached the node, then the run died before recording it
    chain.send = async (raw) => {
      chain.sent.push(raw)
      throw new Error('Lambda timed out')
    }
    await expect(processTx(signerDeps, tx.txId)).rejects.toThrow('Lambda timed out')
    delete (chain as { send?: unknown }).send
    chain.sendOutcomes = [{ kind: 'nonce-too-low', message: 'nonce too low' }]
    expect(await processTx(signerDeps, tx.txId)).toBe('submitted')
    const handedOff = await reload(tx)
    expect(handedOff).toMatchObject({ status: 'submitted', nonce: 0 })

    // mined, but the node the sweeper reads lags: the nonce reads as used with no receipt yet
    chain.nonces.latest = 1
    chain.head = 100
    await sweepChain(deps, FAR)
    expect(await reload(tx)).toMatchObject({ status: 'submitted', nonceUsedAtBlock: 100 })

    chain.head = 101
    chain.mine(handedOff.attempts[0]!.hash, 99)
    expect(await sweepChain(deps, FAR)).toMatchObject({ mined: 1, failed: 0 })
    expect((await reload(tx)).status).toBe('mined')
    chain.head = 103
    expect(await sweepChain(deps, FAR)).toMatchObject({ confirmed: 1 })
    expect(await reload(tx)).toMatchObject({ status: 'confirmed', mined: { hash: handedOff.attempts[0]!.hash } })
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
