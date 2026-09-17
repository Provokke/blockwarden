import { bumpFees } from '@blockwarden/core'
import type { LocalAccount } from 'viem'
import { describeError, type RelayerChain } from './chain.js'
import { feeCap } from './policy.js'
import type { TxQueue } from './queue.js'
import { latestAttempt, liveAttempt, withStatus, type SignerRecord, type TxRecord } from './records.js'
import { attemptFees, signAttempt } from './sign.js'
import { TxConflictError, type RelayerStore } from './store.js'

export type ChainSettings = {
  chainId: number
  // blocks, counting the one the transaction is in, before mined becomes confirmed
  confirmations: number
  // how long a signature may go without a receipt before it is replaced
  stuckAfterMs: number
  // how long a nonce must read as used, with no receipt for any of our hashes, before the transaction is failed;
  // sweeps run a minute apart, so the confirmation depth alone would pass on the second sweep
  nonceUsedMinAgeMs?: number
}

export type SweeperDeps = {
  store: RelayerStore
  chain: RelayerChain
  settings: ChainSettings
  accountFor(signer: SignerRecord): Promise<LocalAccount>
  queue: TxQueue
  now(): Date
  // a queued transaction older than this is sent to the queue again
  requeueAfterMs: number
  log(message: string, data?: Record<string, unknown>, level?: 'warn' | 'error'): void
  // pending transactions read per page; tests set it low to cross page boundaries
  pageSize?: number
}

export type SweepSummary = {
  checked: number
  mined: number
  confirmed: number
  reorged: number
  replaced: number
  rebroadcast: number
  requeued: number
  resumed: number
  failed: number
  feeCapReached: number
  conflicts: number
  // transactions whose sweep threw something other than a conflict; each is logged with its txId
  errors: number
  // the age of the oldest unsettled transaction, for the pending-age alarm
  oldestPendingSeconds: number
}

// replacements stop once this many signatures were not refused; a refused one never reached a mempool, so it does
// not count, or a run of underpriced answers would use the limit up
export const MAX_ATTEMPTS = 10

// DynamoDB caps an item at 400 KB, and with the 8 KB calldata limit a raw is about 17 KB. The tx's own data and
// the signer's abandoned attempts take room too, so past this many the oldest refused attempts give up their bytes
// and keep only their hash, which is what a receipt lookup needs. Refused bytes are never rebroadcast anyway.
export const MAX_SIGNED_ATTEMPTS = 16

const LIST_LIMIT = 100

export const DEFAULT_NONCE_USED_MIN_AGE_MS = 10 * 60_000

export async function sweepChain(deps: SweeperDeps, deadlineMs: number): Promise<SweepSummary> {
  const summary: SweepSummary = {
    checked: 0,
    mined: 0,
    confirmed: 0,
    reorged: 0,
    replaced: 0,
    rebroadcast: 0,
    requeued: 0,
    resumed: 0,
    failed: 0,
    feeCapReached: 0,
    conflicts: 0,
    errors: 0,
    oldestPendingSeconds: 0,
  }
  const pageSize = deps.pageSize ?? LIST_LIMIT
  let page = await deps.store.listPendingPage(deps.settings.chainId, pageSize)
  if (page.txs.length === 0) return summary
  const head = await deps.chain.getBlockNumber()
  const signers = new Map<string, SignerRecord | undefined>()
  // each signer's pause state on this chain, looked up once per sweep
  const pauses = new Map<string, PauseState>()
  // what a resume sent back already, so the loop below does not send it twice
  const requeuedOnResume = new Set<string>()

  // every page, not just the oldest: one stuck signer's backlog must not hide every other signer's transactions
  for (;;) {
    const nowMs = deps.now().getTime()
    for (const tx of page.txs) {
      const age = Math.floor((nowMs - Date.parse(tx.createdAt)) / 1000)
      summary.oldestPendingSeconds = Math.max(summary.oldestPendingSeconds, age)
    }
    for (const tx of page.txs) {
      if (Date.now() >= deadlineMs) return summary
      summary.checked++
      try {
        if (!signers.has(tx.signerId)) signers.set(tx.signerId, await deps.store.getSigner(tx.signerId))
        const signer = signers.get(tx.signerId)
        if (!signer) {
          deps.log('pending transaction names a missing signer', { txId: tx.txId, signerId: tx.signerId })
          continue
        }
        if (tx.status === 'queued') {
          if (!pauses.has(tx.signerId)) {
            pauses.set(tx.signerId, await checkPause(deps, signer, page.txs, requeuedOnResume, summary, deadlineMs))
          }
          const pause = pauses.get(tx.signerId)
          // a paused signer's queue waits for its balance; a resumed signer's queue goes back in full, and the
          // resume itself only saw the page it happened on
          if (pause === 'active') await requeueIfStale(deps, tx, summary)
          else if (pause === 'resumed' && !requeuedOnResume.has(tx.txId)) await requeue(deps, tx, summary)
        } else if (tx.status === 'mined') {
          await checkMined(deps, tx, head, summary)
        } else if (tx.status === 'submitted') {
          await checkSubmitted(deps, signer, tx, head, summary)
        }
      } catch (err) {
        countFailure(deps, tx, err, summary)
      }
    }
    if (!page.cursor || Date.now() >= deadlineMs) return summary
    page = await deps.store.listPendingPage(deps.settings.chainId, pageSize, page.cursor)
  }
}

// A conflict means the signer or an overlapping sweep changed the transaction first, and the next sweep sees the new
// state. Anything else, StoreBusyError included, is one transaction's trouble and must not stop the rest.
function countFailure(deps: SweeperDeps, tx: TxRecord, err: unknown, summary: SweepSummary): void {
  if (err instanceof TxConflictError) {
    summary.conflicts++
    return
  }
  summary.errors++
  deps.log('sweeping a transaction failed', { txId: tx.txId, error: describeError(err) }, 'error')
}

type PauseState = 'active' | 'paused' | 'resumed'

// a paused signer whose balance now covers the transaction that paused it is resumed, and its queue requeued
async function checkPause(
  deps: SweeperDeps,
  signer: SignerRecord,
  pending: TxRecord[],
  requeued: Set<string>,
  summary: SweepSummary,
  deadlineMs: number,
): Promise<PauseState> {
  const pause = await deps.store.getPause(signer.signerId, deps.settings.chainId)
  if (!pause) return 'active'
  const balance = await deps.chain.getBalance(pause.address)
  if (balance < BigInt(pause.requiredWei)) return 'paused'
  // false when the signer paused again since the read; that newer pause is the one to wait on
  if (!(await deps.store.unpause(pause))) return 'paused'
  summary.resumed++
  deps.log('signer resumed', { signerId: signer.signerId, chainId: deps.settings.chainId })
  // lowest nonce first, then oldest, so the signer refills nonces in order
  const queued = pending
    .filter((tx) => tx.signerId === signer.signerId && tx.status === 'queued')
    .sort((a, b) => (a.nonce ?? Infinity) - (b.nonce ?? Infinity) || Date.parse(a.createdAt) - Date.parse(b.createdAt))
  for (const tx of queued) {
    // the pause is already gone, so anything left goes back once it is stale
    if (Date.now() >= deadlineMs) break
    requeued.add(tx.txId)
    try {
      await requeue(deps, tx, summary)
    } catch (err) {
      // one changed transaction must not leave the rest of the queue behind
      countFailure(deps, tx, err, summary)
    }
  }
  return 'resumed'
}

async function requeueIfStale(deps: SweeperDeps, tx: TxRecord, summary: SweepSummary): Promise<void> {
  if (deps.now().getTime() - tx.enqueuedAt < deps.requeueAfterMs) return
  await requeue(deps, tx, summary)
}

async function requeue(deps: SweeperDeps, tx: TxRecord, summary: SweepSummary): Promise<void> {
  const saved = await deps.store.saveTx(
    { ...tx, enqueuedAt: deps.now().getTime(), enqueues: tx.enqueues + 1 },
    deps.now().toISOString(),
  )
  await deps.queue.send(saved)
  summary.requeued++
}

async function checkMined(deps: SweeperDeps, tx: TxRecord, head: number, summary: SweepSummary): Promise<void> {
  const mined = tx.mined!
  const receipt = await deps.chain.getReceipt(mined.hash)
  const at = deps.now().toISOString()
  if (!receipt || receipt.blockHash !== mined.blockHash) {
    // reorged out, or back in a different block: submitted again, and the mined bytes go back to the mempool
    const { mined: _mined, ...rest } = tx
    await deps.store.saveTx(withStatus(rest, 'submitted', at), at)
    summary.reorged++
    const raw = tx.attempts.find((a) => a.hash === mined.hash)?.raw
    if (raw && raw !== '0x') await deps.chain.send(raw)
    return
  }
  if (head - mined.blockNumber + 1 >= deps.settings.confirmations) {
    await deps.store.saveTx(withStatus(tx, 'confirmed', at), at)
    summary.confirmed++
  }
}

async function checkSubmitted(
  deps: SweeperDeps,
  signer: SignerRecord,
  tx: TxRecord,
  head: number,
  summary: SweepSummary,
): Promise<void> {
  const at = deps.now().toISOString()
  // newest first: a replacement is the likeliest to have been mined
  for (const attempt of [...tx.attempts].reverse()) {
    const receipt = await deps.chain.getReceipt(attempt.hash)
    if (receipt) return markMined(deps, tx, receipt, head, summary)
  }

  const minedNonce = await deps.chain.getNonce(tx.from, 'latest')
  if (minedNonce > tx.nonce!) {
    // The nonce is used, but by none of our hashes. A lagging node can show that for a while, so wait both the
    // confirmation depth and a minimum age, then ask every URL, before deciding it was replaced from outside.
    if (tx.nonceUsedAtBlock === undefined || tx.nonceUsedAt === undefined) {
      await deps.store.saveTx({ ...tx, nonceUsedAtBlock: tx.nonceUsedAtBlock ?? head, nonceUsedAt: at }, at)
      return
    }
    const minAge = deps.settings.nonceUsedMinAgeMs ?? DEFAULT_NONCE_USED_MIN_AGE_MS
    if (head - tx.nonceUsedAtBlock < deps.settings.confirmations) return
    if (deps.now().getTime() - Date.parse(tx.nonceUsedAt) < minAge) return
    for (const attempt of [...tx.attempts].reverse()) {
      let receipt
      try {
        receipt = await deps.chain.findReceipt(attempt.hash)
      } catch (err) {
        // a URL that could not answer might be the one with the receipt
        deps.log(
          'receipt check failed on an RPC URL; not failing the transaction this sweep',
          { txId: tx.txId, error: describeError(err) },
          'warn',
        )
        return
      }
      if (receipt) return markMined(deps, tx, receipt, head, summary)
    }
    await deps.store.saveTx(
      { ...withStatus(tx, 'failed', at), error: 'the nonce was used by a transaction this relayer did not send' },
      at,
    )
    summary.failed++
    return
  }
  if (tx.nonceUsedAtBlock !== undefined || tx.nonceUsedAt !== undefined) {
    // the node that read the nonce as used was ahead or wrong; a later sighting starts the wait again
    const { nonceUsedAtBlock: _n, nonceUsedAt: _t, ...rest } = tx
    tx = await deps.store.saveTx(rest, at)
  }

  const stuck = deps.now().getTime() - latestAttempt(tx)!.signedAt >= deps.settings.stuckAfterMs
  // a replacement only helps the next nonce to be mined; a later one waits for the gap below it either way
  if (minedNonce === tx.nonce && (tx.needsBump || stuck)) {
    if (await replace(deps, signer, tx, summary)) return
  }
  // a node forgets a transaction it evicted, and a crash can come between saving an attempt and sending it
  const live = liveAttempt(tx)
  if (live && !(await deps.chain.isKnown(live.hash))) {
    await deps.chain.send(live.raw)
    summary.rebroadcast++
  }
}

async function markMined(
  deps: SweeperDeps,
  tx: TxRecord,
  receipt: NonNullable<TxRecord['mined']>,
  head: number,
  summary: SweepSummary,
): Promise<void> {
  const at = deps.now().toISOString()
  const { nonceUsedAtBlock: _n, nonceUsedAt: _t, needsBump: _b, ...rest } = tx
  const mined = await deps.store.saveTx({ ...withStatus(rest, 'mined', at), mined: receipt }, at)
  summary.mined++
  if (head - receipt.blockNumber + 1 >= deps.settings.confirmations) {
    await deps.store.saveTx(withStatus(mined, 'confirmed', at), at)
    summary.confirmed++
  }
}

async function replace(deps: SweeperDeps, signer: SignerRecord, tx: TxRecord, summary: SweepSummary): Promise<boolean> {
  const at = deps.now().toISOString()
  // every replacement clears the one before it, so the latest attempt, refused or not, carries the highest fees
  const previous = attemptFees(latestAttempt(tx)!)
  const bump = bumpFees(previous, await deps.chain.estimateFees(), feeCap(signer.policy))
  const unrefused = tx.attempts.filter((a) => a.rejected === undefined).length
  if (!bump.ok || unrefused >= MAX_ATTEMPTS) {
    if (!tx.feeCapReached) {
      await deps.store.saveTx({ ...tx, feeCapReached: true }, at)
      deps.log('cannot replace: the fee cap or the attempt limit is reached', {
        txId: tx.txId,
        required: bump.ok ? undefined : { ...bump.required },
        attempts: unrefused,
      })
    }
    summary.feeCapReached++
    return false
  }
  const account = await deps.accountFor(signer)
  const attempt = await signAttempt(account, tx, bump.fees, deps.now().getTime())
  const { needsBump: _b, ...rest } = tx
  const saved = await deps.store.saveTx({ ...rest, attempts: [...makeRoom(tx.attempts), attempt] }, at)
  const outcome = await deps.chain.send(attempt.raw)
  summary.replaced++
  if (outcome.kind === 'underpriced' || outcome.kind === 'rejected' || outcome.kind === 'insufficient-funds') {
    if (outcome.kind === 'insufficient-funds') {
      await deps.store.pauseForFunds(tx, account.address, attempt.maxFeePerGas, at)
      deps.log('signer paused: insufficient funds', { signerId: signer.signerId, chainId: tx.chainId, txId: tx.txId })
    }
    // the earlier attempts may still be in the mempool, so a refused replacement does not fail the transaction
    const attempts = saved.attempts.map((a) => (a.hash === attempt.hash ? { ...a, rejected: outcome.message } : a))
    await deps.store.saveTx({ ...saved, attempts, ...(outcome.kind === 'underpriced' ? { needsBump: true } : {}) }, at)
  }
  return true
}

// leaves room for one more signed attempt by dropping the bytes of the oldest refused ones
function makeRoom(attempts: TxRecord['attempts']): TxRecord['attempts'] {
  let over = attempts.filter((a) => a.raw !== '0x').length + 1 - MAX_SIGNED_ATTEMPTS
  return attempts.map((a) => {
    if (over <= 0 || a.rejected === undefined || a.raw === '0x') return a
    over--
    return { ...a, raw: '0x' }
  })
}
