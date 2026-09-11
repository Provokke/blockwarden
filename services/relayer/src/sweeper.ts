import { bumpFees, clampFees, type Fees } from '@blockwarden/core'
import type { Hex, LocalAccount } from 'viem'
import { describeError, type RelayerChain, type SendOutcome } from './chain.js'
import { feeCap } from './policy.js'
import type { TxQueue } from './queue.js'
import {
  dependencyState,
  latestAttempt,
  liveAttempt,
  markAccepted,
  withStatus,
  type Attempt,
  type SignerRecord,
  type TxRecord,
} from './records.js'
import { refuseAttempt } from './refusal.js'
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
  // transactions that needed room for a signature while retiredHashes was full
  retiredHashesFull: number
  conflicts: number
  // transactions whose sweep threw something other than a conflict; each is logged with its txId
  errors: number
  // the age of the oldest unsettled transaction, for the pending-age alarm
  oldestPendingSeconds: number
}

// replacements stop once this many signatures were not refused; a refused one never reached a mempool, so it does
// not count, or a run of underpriced answers would use the limit up
export const MAX_ATTEMPTS = 10

// a raw can be 17 KB and an item at most 400 KB, so past this many the oldest refused attempts keep only their hash
export const MAX_SIGNED_ATTEMPTS = 16

// 16 signed at 17 KB plus the calldata is about 290 KB, leaving room for 48 hash-only attempts at up to 450 bytes
// each with over 80 KB to spare; past this the oldest refused attempt goes to make room, keeping only its hash, so the
// item cannot outgrow 400 KB
export const MAX_STORED_ATTEMPTS = 64

// A dropped attempt's hash is kept, since a node may have taken it before refusing it. At about 70 bytes a hash this
// is about 36 KB, which fits the 80 KB left over above; once it is full nothing more is signed for the transaction.
export const MAX_RETIRED_HASHES = 512

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
    retiredHashesFull: 0,
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
    for (const [position, tx] of page.txs.entries()) {
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
          // an equal share of what is left, so one transaction's hundreds of hash lookups cannot use the sweep up
          const share = Math.floor((deadlineMs - Date.now()) / (page.txs.length - position))
          await checkSubmitted(deps, signer, tx, head, summary, Date.now() + share)
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
    // a signature made again at the same fees has the same hash, so skip a copy whose bytes were dropped
    const attempt = tx.attempts.find((a) => a.hash === mined.hash && a.raw !== '0x')
    if (attempt) await rebroadcast(deps, signer, saved, attempt, summary)
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
  deadlineMs: number,
): Promise<void> {
  const at = deps.now().toISOString()
  // A transaction can hold hundreds of hashes, so a walk stops at its slice of the sweep and saves how far it got;
  // the next sweep carries on from there. Newest first: a replacement is the likeliest to have been mined.
  const walk: LookupWalk = readyToFail(deps, tx, head) ? 'all-urls' : 'receipts'
  const from = tx.lookupFrom?.walk === walk ? tx.lookupFrom.index : 0
  let index = 0

  // the all-URL walk below asks for each of these hashes too, so it does not repeat them
  if (walk === 'receipts') {
    for (const attempt of [...tx.attempts].reverse()) {
      if (index++ < from) continue
      if (Date.now() >= deadlineMs) return stopLookup(deps, tx, walk, index - 1, at)
      const receipt = await deps.chain.getReceipt(attempt.hash)
      if (receipt) return markMined(deps, tx, receipt, head, summary)
    }
  }

  const minedNonce = await deps.chain.getNonce(tx.from, 'latest')
  if (minedNonce > tx.nonce!) {
    if (walk === 'receipts') {
      // a retired hash can only be mined once the nonce is used, so its up to 512 lookups wait for that
      for (const hash of [...(tx.retiredHashes ?? [])].reverse()) {
        if (index++ < from) continue
        if (Date.now() >= deadlineMs) return stopLookup(deps, tx, walk, index - 1, at)
        const receipt = await deps.chain.getReceipt(hash)
        if (receipt) return markMined(deps, tx, receipt, head, summary)
      }
      // The nonce is used, but by none of our hashes. A lagging node can show that for a while, so wait both the
      // confirmation depth and a minimum age, then ask every URL, before deciding it was replaced from outside.
      if (tx.nonceUsedAtBlock === undefined || tx.nonceUsedAt === undefined) {
        const seen = { ...tx, nonceUsedAtBlock: tx.nonceUsedAtBlock ?? head, nonceUsedAt: at }
        await deps.store.saveTx(withoutLookup(seen), at)
        return
      }
      // this walk is over, so the next sweep starts at the newest hash again
      if (tx.lookupFrom !== undefined) await deps.store.saveTx(withoutLookup(tx), at)
      return
    }
    for (const hash of receiptHashes(tx)) {
      if (index++ < from) continue
      if (Date.now() >= deadlineMs) return stopLookup(deps, tx, walk, index - 1, at)
      let receipt
      try {
        receipt = await deps.chain.findReceipt(hash)
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
      {
        ...withStatus(withoutLookup(tx), 'failed', at),
        error: 'the nonce was used by a transaction this relayer did not send',
      },
      at,
    )
    summary.failed++
    return
  }
  if (tx.nonceUsedAtBlock !== undefined || tx.nonceUsedAt !== undefined || tx.lookupFrom !== undefined) {
    // the node that read the nonce as used was ahead or wrong; a later sighting starts the wait again
    const { nonceUsedAtBlock: _n, nonceUsedAt: _t, lookupFrom: _l, ...rest } = tx
    tx = await deps.store.saveTx(rest, at)
  }

  const stuck = deps.now().getTime() - lastSentAt(tx) >= deps.settings.stuckAfterMs
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
    case 'accepted':
    case 'already-known':
    case 'unknown': {
      if (attempt.rejected === undefined && attempt.acceptedAt !== undefined) return
      const now = deps.now().getTime()
      // a refused attempt the node now takes is live again
      const attempts = markAccepted(tx.attempts, attempt.hash, now).map((a) => {
        if (attempt.rejected === undefined || a.hash !== attempt.hash || a.raw !== attempt.raw) return a
        const { rejected: _r, ...live } = a
        return { ...live, broadcastAt: now }
      })
      const { needsBump: _b, feeCapReached: _f, ...rest } = tx
      await deps.store.saveTx({ ...(attempt.rejected === undefined ? tx : rest), attempts }, at)
      return
    }
    case 'rejected':
      await refuse(deps, tx, attempt, outcome.message, summary)
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
  const { nonceUsedAtBlock: _n, nonceUsedAt: _t, needsBump: _b, lookupFrom: _l, ...rest } = tx
  // a receipt proves a node took the signature, which counts if a reorg sends it back and a node refuses it
  const attempts = markAccepted(tx.attempts, receipt.hash, deps.now().getTime())
  const retired = tx.attempts.some((a) => a.hash === receipt.hash) ? {} : { retiredAccepted: true }
  const mined = await deps.store.saveTx({ ...withStatus(rest, 'mined', at), mined: receipt, attempts, ...retired }, at)
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
    // nothing is in a mempool to outbid; over the cap, bytes at the cap may still be taken once the base fee dips
    if (estimate.maxFeePerGas > cap.maxFeePerGas) {
      tx = await flagFeeCap(deps, tx, summary, { estimate: { ...estimate } })
    }
    fees = clampFees(estimate, cap)
    const blocking = refusedAtOrAbove(tx, fees, cap)
    if (blocking.length > 0) {
      // Signing the same or lower fees again only grows the item, but the base fee may have fallen since the
      // refusal, so the stored bytes go out again. Without them, one signature at those fees takes their place.
      const top = blocking.find((a) => a.raw !== '0x')
      if (top) {
        await rebroadcast(deps, signer, tx, top, summary)
        return undefined
      }
      fees = clampFees(attemptFees(blocking[0]!), cap)
    }
  }

  // checked only now, so stored bytes above still go out at the limit
  let kept = tx.attempts
  let retired = tx.retiredHashes
  let retiredAccepted = tx.retiredAccepted
  if (kept.length >= MAX_STORED_ATTEMPTS) {
    const drop = dropIndex(kept)
    if (drop === -1) return flagFeeCap(deps, tx, summary, { attempts: kept.length })
    if ((retired?.length ?? 0) >= MAX_RETIRED_HASHES) return flagRetiredHashesFull(deps, tx, summary)
    const { hash, acceptedAt } = kept[drop]!
    if (acceptedAt !== undefined) retiredAccepted = true
    kept = kept.toSpliced(drop, 1)
    // a twin signed at the same fees shares the hash, and one copy is enough
    if (!kept.some((a) => a.hash === hash) && !retired?.includes(hash)) retired = [...(retired ?? []), hash]
  }
  const account = await deps.accountFor(signer)
  const attempt = await signAttempt(account, tx, fees, deps.now().getTime())
  const { needsBump: _b, ...rest } = tx
  const saved = await deps.store.saveTx(
    {
      ...rest,
      attempts: [...makeRoom(kept), attempt],
      ...(retired ? { retiredHashes: retired } : {}),
      ...(retiredAccepted ? { retiredAccepted } : {}),
    },
    at,
  )
  const outcome = await deps.chain.send(attempt.raw)
  summary.replaced++
  await afterReplacement(deps, signer, saved, attempt, outcome, summary)
  return undefined
}

async function afterReplacement(
  deps: SweeperDeps,
  signer: SignerRecord,
  tx: TxRecord,
  attempt: Attempt,
  outcome: SendOutcome,
  summary: SweepSummary,
): Promise<void> {
  const at = deps.now().toISOString()
  if (outcome.kind === 'accepted' || outcome.kind === 'already-known' || outcome.kind === 'unknown') {
    const { feeCapReached: _f, ...rest } = tx
    await deps.store.saveTx({ ...rest, attempts: markAccepted(tx.attempts, attempt.hash, deps.now().getTime()) }, at)
    return
  }
  if (outcome.kind === 'nonce-too-low') return
  if (outcome.kind === 'rejected') return refuse(deps, tx, attempt, outcome.message, summary)
  if (outcome.kind === 'insufficient-funds') await pauseSigner(deps, signer, tx, attempt, at)
  // the earlier attempts may still be in the mempool, so a refused replacement does not fail the transaction
  const attempts = tx.attempts.map((a) => (a.hash === attempt.hash ? { ...a, rejected: outcome.message } : a))
  await deps.store.saveTx({ ...tx, attempts, ...(outcome.kind === 'underpriced' ? { needsBump: true } : {}) }, at)
}

// the signer's rule too: failed with a filler only when no node ever took a signature at the nonce
async function refuse(
  deps: SweeperDeps,
  tx: TxRecord,
  attempt: Attempt,
  message: string,
  summary: SweepSummary,
): Promise<void> {
  if ((await refuseAttempt(deps, deps.chain, tx, attempt.hash, tx.from, message)) === 'failed') summary.failed++
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

// Its own flag rather than feeCapReached, which a node taking any bytes clears: this limit never lifts, so the
// warning would repeat after every revival.
async function flagRetiredHashesFull(deps: SweeperDeps, tx: TxRecord, summary: SweepSummary): Promise<TxRecord> {
  summary.retiredHashesFull++
  if (tx.retiredHashesFull) return tx
  const saved = await deps.store.saveTx({ ...tx, retiredHashesFull: true }, deps.now().toISOString())
  deps.log(
    'cannot sign again: the limit of dropped attempt hashes is reached, so stored bytes are only rebroadcast',
    { txId: tx.txId, retiredHashes: tx.retiredHashes?.length },
    'warn',
  )
  return saved
}

type LookupWalk = NonNullable<TxRecord['lookupFrom']>['walk']

// the nonce has read as used long enough that the next step is asking every URL and then failing the transaction
function readyToFail(deps: SweeperDeps, tx: TxRecord, head: number): boolean {
  if (tx.nonceUsedAtBlock === undefined || tx.nonceUsedAt === undefined) return false
  const minAge = deps.settings.nonceUsedMinAgeMs ?? DEFAULT_NONCE_USED_MIN_AGE_MS
  return (
    head - tx.nonceUsedAtBlock >= deps.settings.confirmations &&
    deps.now().getTime() - Date.parse(tx.nonceUsedAt) >= minAge
  )
}

// where this sweep ran out of its slice; a part of a walk decides nothing
async function stopLookup(deps: SweeperDeps, tx: TxRecord, walk: LookupWalk, index: number, at: string): Promise<void> {
  await deps.store.saveTx({ ...tx, lookupFrom: { walk, index } }, at)
}

function withoutLookup(tx: TxRecord): TxRecord {
  const { lookupFrom: _l, ...rest } = tx
  return rest
}

// every hash of ours that could be mined at this nonce, stored attempts first, newest first
function receiptHashes(tx: TxRecord): Hex[] {
  return [...tx.attempts.map((a) => a.hash).reverse(), ...[...(tx.retiredHashes ?? [])].reverse()]
}

function raises(next: Fees, previous: Fees): boolean {
  return next.maxFeePerGas > previous.maxFeePerGas || next.maxPriorityFeePerGas > previous.maxPriorityFeePerGas
}

// Refused attempts with fees at least as high as these, highest first. A refusal at the cap only says the cap was too
// low at the time, so it does not hold back fees the cap no longer touches; that is how a transaction refused during
// a spike recovers once fees fall.
function refusedAtOrAbove(tx: TxRecord, fees: Fees, cap: Fees): Attempt[] {
  return tx.attempts
    .filter(
      (a) =>
        a.rejected !== undefined && !raises(fees, attemptFees(a)) && (atCap(fees, cap) || !atCap(attemptFees(a), cap)),
    )
    .sort((a, b) => compareFees(attemptFees(b), attemptFees(a)))
}

function compareFees(a: Fees, b: Fees): number {
  const diff = a.maxFeePerGas - b.maxFeePerGas || a.maxPriorityFeePerGas - b.maxPriorityFeePerGas
  return diff > 0n ? 1 : diff < 0n ? -1 : 0
}

function atCap(fees: Fees, cap: Fees): boolean {
  return fees.maxFeePerGas >= cap.maxFeePerGas || fees.maxPriorityFeePerGas >= cap.maxPriorityFeePerGas
}

// a revived attempt was only just taken by the node, so it gets the full stuck threshold again
function lastSentAt(tx: TxRecord): number {
  return Math.max(...tx.attempts.map((a) => a.broadcastAt ?? a.signedAt))
}

// the oldest refused attempt, preferring one whose bytes are already gone; one the node took is never dropped
function dropIndex(attempts: TxRecord['attempts']): number {
  const stripped = attempts.findIndex((a) => a.rejected !== undefined && a.raw === '0x')
  return stripped !== -1 ? stripped : attempts.findIndex((a) => a.rejected !== undefined)
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
