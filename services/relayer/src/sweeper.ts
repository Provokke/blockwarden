import { bumpFees, clampFees, type Fees } from '@blockwarden/core'
import type { LocalAccount } from 'viem'
import { describeError, type RelayerChain, type SendOutcome } from './chain.js'
import { feeCap } from './policy.js'
import type { TxQueue } from './queue.js'
import {
  dependencyState,
  latestAttempt,
  liveAttempt,
  withStatus,
  type Attempt,
  type SignerRecord,
  type TxRecord,
} from './records.js'
import { failRefused } from './refusal.js'
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
  // for the filler that takes the nonce of a transaction whose rebroadcast is refused
  newTxId(): string
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
          deps.log('pending transaction names a missing signer', { txId: tx.txId, signerId: tx.signerId }, 'warn')
          continue
        }
        if (tx.status === 'queued') {
          if (!pauses.has(tx.signerId)) {
            pauses.set(tx.signerId, await checkPause(deps, signer, page.txs, requeuedOnResume, summary, deadlineMs))
          }
          const pause = pauses.get(tx.signerId)
          // a paused signer's queue waits for its balance; a resumed signer's queue goes back in full, and the
          // resume itself only saw the page it happened on
          if (pause === 'resumed' && !requeuedOnResume.has(tx.txId)) await requeue(deps, tx, summary)
          if (pause !== 'active') continue
          if (tx.dependsOn !== undefined && tx.nonce === undefined) await requeueIfDependencySettled(deps, tx, summary)
          else await requeueIfStale(deps, tx, summary)
        } else if (tx.status === 'mined') {
          await checkMined(deps, signer, tx, head, summary)
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

// a dependent transaction is not requeued while it waits; once its dependency settles it goes back to the signer,
// once, and after that only as any other stale transaction would
async function requeueIfDependencySettled(deps: SweeperDeps, tx: TxRecord, summary: SweepSummary): Promise<void> {
  const dependency = await deps.store.getTx(tx.dependsOn!)
  if (dependencyState(dependency) === 'waiting') return
  if (dependency && tx.enqueuedAt >= Date.parse(dependency.updatedAt)) return requeueIfStale(deps, tx, summary)
  await requeue(deps, tx, summary)
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

async function checkMined(
  deps: SweeperDeps,
  signer: SignerRecord,
  tx: TxRecord,
  head: number,
  summary: SweepSummary,
): Promise<void> {
  const mined = tx.mined!
  const receipt = await deps.chain.getReceipt(mined.hash)
  const at = deps.now().toISOString()
  if (!receipt || receipt.blockHash !== mined.blockHash) {
    // reorged out, or back in a different block: submitted again, and the mined bytes go back to the mempool
    const { mined: _mined, ...rest } = tx
    const saved = await deps.store.saveTx(withStatus(rest, 'submitted', at), at)
    summary.reorged++
    const attempt = tx.attempts.find((a) => a.hash === mined.hash)
    if (attempt && attempt.raw !== '0x') await rebroadcast(deps, signer, saved, attempt, summary)
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
    const unchanged = await replace(deps, signer, tx, summary)
    if (!unchanged) return
    tx = unchanged
  }
  // a node forgets a transaction it evicted, and a crash can come between saving an attempt and sending it
  const live = liveAttempt(tx)
  if (live && !(await deps.chain.isKnown(live.hash))) await rebroadcast(deps, signer, tx, live, summary)
}

async function rebroadcast(
  deps: SweeperDeps,
  signer: SignerRecord,
  tx: TxRecord,
  attempt: Attempt,
  summary: SweepSummary,
): Promise<void> {
  const outcome = await deps.chain.send(attempt.raw)
  summary.rebroadcast++
  const at = deps.now().toISOString()
  switch (outcome.kind) {
    case 'rejected':
      await failRefused(deps, deps.chain, tx, attempt.hash, tx.from, outcome.message)
      summary.failed++
      return
    case 'insufficient-funds':
      await pauseSigner(deps, signer, tx, attempt, at)
      return
    case 'underpriced':
      if (!tx.needsBump) await deps.store.saveTx({ ...tx, needsBump: true }, at)
      return
  }
}

async function pauseSigner(deps: SweeperDeps, signer: SignerRecord, tx: TxRecord, attempt: Attempt, at: string) {
  await deps.store.pauseForFunds(tx, tx.from, attempt.maxFeePerGas, at)
  deps.log(
    'signer paused: insufficient funds',
    { signerId: signer.signerId, chainId: tx.chainId, txId: tx.txId },
    'warn',
  )
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

// Returns the transaction as it now stands when nothing was sent, so the caller can still rebroadcast it.
async function replace(
  deps: SweeperDeps,
  signer: SignerRecord,
  tx: TxRecord,
  summary: SweepSummary,
): Promise<TxRecord | undefined> {
  const at = deps.now().toISOString()
  const cap = feeCap(signer.policy)
  const estimate = await deps.chain.estimateFees()
  const live = liveAttempt(tx)
  let fees: Fees
  if (live) {
    // a refused signature never reached a mempool, so only the live one sets the replacement minimum
    let bump = bumpFees(attemptFees(live), estimate, cap)
    const latest = latestAttempt(tx)!
    // unless the node already refused fees at least this high; then keep climbing from those
    if (bump.ok && latest !== live && !raises(bump.fees, attemptFees(latest))) {
      bump = bumpFees(attemptFees(latest), estimate, cap)
    }
    const unrefused = tx.attempts.filter((a) => a.rejected === undefined).length
    if (!bump.ok || unrefused >= MAX_ATTEMPTS) {
      return flagFeeCap(deps, tx, summary, {
        required: bump.ok ? undefined : { ...bump.required },
        attempts: unrefused,
      })
    }
    fees = bump.fees
  } else {
    // nothing is in a mempool to outbid, but a signature under a base fee above the cap would only be refused again
    if (estimate.maxFeePerGas > cap.maxFeePerGas) {
      return flagFeeCap(deps, tx, summary, { estimate: { ...estimate } })
    }
    fees = clampFees(estimate, cap)
  }

  const account = await deps.accountFor(signer)
  const attempt = await signAttempt(account, tx, fees, deps.now().getTime())
  const { needsBump: _b, ...rest } = tx
  const saved = await deps.store.saveTx({ ...rest, attempts: [...makeRoom(tx.attempts), attempt] }, at)
  const outcome = await deps.chain.send(attempt.raw)
  summary.replaced++
  await afterReplacement(deps, signer, saved, attempt, outcome, live === undefined, summary)
  return undefined
}

async function afterReplacement(
  deps: SweeperDeps,
  signer: SignerRecord,
  tx: TxRecord,
  attempt: Attempt,
  outcome: SendOutcome,
  nothingLive: boolean,
  summary: SweepSummary,
): Promise<void> {
  const at = deps.now().toISOString()
  if (outcome.kind === 'accepted' || outcome.kind === 'already-known' || outcome.kind === 'unknown') {
    if (tx.feeCapReached) {
      const { feeCapReached: _f, ...rest } = tx
      await deps.store.saveTx(rest, at)
    }
    return
  }
  if (outcome.kind === 'nonce-too-low') return
  // with no earlier signature in a mempool, an outright refusal is as final as it is for the signer
  if (outcome.kind === 'rejected' && nothingLive) {
    await failRefused(deps, deps.chain, tx, attempt.hash, tx.from, outcome.message)
    summary.failed++
    return
  }
  if (outcome.kind === 'insufficient-funds') await pauseSigner(deps, signer, tx, attempt, at)
  // the earlier attempts may still be in the mempool, so a refused replacement does not fail the transaction
  const attempts = tx.attempts.map((a) => (a.hash === attempt.hash ? { ...a, rejected: outcome.message } : a))
  await deps.store.saveTx({ ...tx, attempts, ...(outcome.kind === 'underpriced' ? { needsBump: true } : {}) }, at)
}

async function flagFeeCap(
  deps: SweeperDeps,
  tx: TxRecord,
  summary: SweepSummary,
  data: Record<string, unknown>,
): Promise<TxRecord> {
  summary.feeCapReached++
  if (tx.feeCapReached) return tx
  const saved = await deps.store.saveTx({ ...tx, feeCapReached: true }, deps.now().toISOString())
  deps.log('cannot replace: the fee cap or the attempt limit is reached', { txId: tx.txId, ...data }, 'warn')
  return saved
}

function raises(next: Fees, previous: Fees): boolean {
  return next.maxFeePerGas > previous.maxFeePerGas || next.maxPriorityFeePerGas > previous.maxPriorityFeePerGas
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
