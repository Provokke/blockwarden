import { clampFees } from '@blockwarden/core'
import type { Hex, LocalAccount } from 'viem'
import { DEADLINE_MARGIN_MS } from './batch.js'
import { describeError, EstimateError, short, type RelayerChain } from './chain.js'
import { feeCap } from './policy.js'
import type { TxQueue } from './queue.js'
import {
  dependencyState,
  latestAttempt,
  markAccepted,
  withStatus,
  type SignerRecord,
  type TxRecord,
} from './records.js'
import { refuseAttempt } from './refusal.js'
import { signAttempt } from './sign.js'
import type { RelayerStore } from './store.js'

export type SignerDeps = {
  store: RelayerStore
  chainFor(chainId: number): RelayerChain | undefined
  accountFor(signer: SignerRecord): Promise<LocalAccount>
  queue: TxQueue
  now(): Date
  newTxId(): string
  // signer and chain pairs whose nonce counter this container has reconciled with the chain
  reconciled: Set<string>
  log(message: string, data?: Record<string, unknown>, level?: 'warn' | 'error'): void
}

export type ProcessOutcome = 'missing' | 'skipped' | 'paused' | 'waiting' | 'submitted' | 'failed'

// a nonce taken by another sender forces a fresh one; twice in a row means something else keeps sending
const MAX_NONCE_RESETS = 2

// redelivery and the sweeper's requeue repeat resets across runs, so only the newest are kept; they are evidence and
// never sent again, so their bytes are dropped
export const MAX_ABANDONED_ATTEMPTS = 4

// remainingMs is the Lambda's time left, when there is one
export async function processTx(deps: SignerDeps, txId: string, remainingMs?: () => number): Promise<ProcessOutcome> {
  const { store } = deps
  const stamp = () => deps.now().toISOString()
  // the nonce this run took from the counter: no earlier run can have broadcast anything at it
  let takenNonce: number | undefined
  let tx = await store.getTx(txId)
  if (!tx) return 'missing'
  if (tx.status !== 'queued') return 'skipped'
  const signer = await store.getSigner(tx.signerId)
  if (!signer) throw new Error(`transaction ${txId} names signer ${tx.signerId}, which does not exist`)
  const chain = deps.chainFor(tx.chainId)
  if (!chain) throw new Error(`transaction ${txId} is for chain ${tx.chainId}, which has no RPC configured`)
  // the sweeper requeues a paused signer's transactions once its balance covers them
  if (await store.getPause(signer.signerId, tx.chainId)) return 'paused'

  const account = await deps.accountFor(signer)
  const pair = `${signer.signerId}#${tx.chainId}`

  if (tx.dependsOn !== undefined && tx.nonce === undefined) {
    const state = dependencyState(await store.getTx(tx.dependsOn))
    // the sweeper requeues this transaction once its dependency settles
    if (state === 'waiting') return 'waiting'
    const failure: DependencyFailure | undefined =
      state === 'unsuccessful'
        ? { reason: 'the transaction this one depends on did not succeed' }
        : await revertsNow(deps, chain, account.address, tx)
    if (failure) {
      // no nonce was taken, so no filler is needed
      await store.saveTx(
        {
          ...withStatus(tx, 'failed', stamp()),
          error: failure.reason,
          ...(failure.revertData === undefined ? {} : { revertData: failure.revertData }),
        },
        stamp(),
      )
      return 'failed'
    }
  }

  for (let resets = 0; ; resets++) {
    // the batch margin covers one pass; a fresh nonce is another pass, and the reset above is already saved
    if (resets > 0 && remainingMs && remainingMs() < DEADLINE_MARGIN_MS) {
      throw new Error(`too little time left to send transaction ${txId} at a fresh nonce; SQS will deliver it again`)
    }
    if (tx.nonce === undefined) {
      // on a cold start the counter may be behind the chain, for example after a key was used elsewhere
      if (!deps.reconciled.has(pair)) {
        await store.raiseNonce(signer.signerId, tx.chainId, await chain.getNonce(account.address, 'pending'))
        deps.reconciled.add(pair)
      }
      tx = await store.assignNonce(tx, stamp())
      takenNonce = tx.nonce
    }
    if (tx.attempts.length === 0) {
      const fees = clampFees(await chain.estimateFees(), feeCap(signer.policy))
      // saved before sending, so a crash after the send rebroadcasts these bytes instead of signing different ones
      tx = await store.saveTx(
        { ...tx, attempts: [await signAttempt(account, tx, fees, deps.now().getTime())] },
        stamp(),
      )
    }

    const attempt = latestAttempt(tx)!
    const outcome = await chain.send(attempt.raw)
    switch (outcome.kind) {
      case 'accepted':
      case 'already-known':
      // an unclassified answer or a timeout may still have reached the mempool; the sweeper settles it by hash
      case 'unknown': {
        const attempts = markAccepted(tx.attempts, attempt.hash, deps.now().getTime())
        await store.saveTx({ ...withStatus(tx, 'submitted', stamp()), attempts }, stamp())
        return 'submitted'
      }

      case 'underpriced': {
        // below the base fee or the node's minimum: the sweeper replaces it on its next run
        const attempts = tx.attempts.map((a) => (a.hash === attempt.hash ? { ...a, rejected: outcome.message } : a))
        await store.saveTx({ ...withStatus(tx, 'submitted', stamp()), attempts, needsBump: true }, stamp())
        return 'submitted'
      }

      case 'insufficient-funds': {
        await store.pauseForFunds(tx, account.address, attempt.maxFeePerGas, stamp())
        deps.log('signer paused: insufficient funds', { signerId: signer.signerId, chainId: tx.chainId, txId }, 'warn')
        return 'paused'
      }

      case 'nonce-too-low': {
        for (const a of tx.attempts) {
          if (await chain.getReceipt(a.hash)) {
            await store.saveTx(withStatus(tx, 'submitted', stamp()), stamp())
            return 'submitted'
          }
        }
        // an earlier run's bytes at this nonce may be mined behind a lagging node; a new nonce could run them twice
        if (tx.nonce !== takenNonce) {
          await store.saveTx(withStatus(tx, 'submitted', stamp()), stamp())
          deps.log('nonce too low on a nonce sent before; left to the sweeper', { txId, nonce: tx.nonce }, 'warn')
          return 'submitted'
        }
        if (resets >= MAX_NONCE_RESETS) throw new Error(`transaction ${txId} kept hitting nonce too low`)
        // another sender used this nonce: give it up and take the next one after reconciling
        deps.reconciled.delete(pair)
        const { nonce, ...rest } = tx
        const abandoned = tx.attempts.map((a) => ({ ...a, nonce: nonce!, rejected: outcome.message }))
        const kept = [...(tx.abandonedAttempts ?? []), ...abandoned]
          .slice(-MAX_ABANDONED_ATTEMPTS)
          .map((a) => ({ ...a, raw: '0x' as const }))
        tx = await store.saveTx({ ...rest, attempts: [], abandonedAttempts: kept }, stamp())
        continue
      }

      case 'rejected':
        // a first send was never taken by a node, so this fails it with a filler
        return refuseAttempt(deps, chain, tx, attempt.hash, account.address, outcome.message)
    }
  }
}

type DependencyFailure = { reason: string; revertData?: Hex }

// the estimate the API skipped for a dependent transaction, run once its dependency is confirmed
async function revertsNow(
  deps: SignerDeps,
  chain: RelayerChain,
  from: TxRecord['from'],
  tx: TxRecord,
): Promise<DependencyFailure | undefined> {
  try {
    const estimate = await chain.estimateGas({ from, to: tx.to, data: tx.data, value: BigInt(tx.value) })
    // the caller fixed gasLimit before this estimate existed; still send it, just flag that it may run short
    if (BigInt(tx.gasLimit) < estimate) {
      deps.log(
        'dependent transaction gas limit is below the estimate',
        { txId: tx.txId, gasLimit: tx.gasLimit, estimate: estimate.toString() },
        'warn',
      )
    }
    return undefined
  } catch (err) {
    if (!(err instanceof EstimateError)) throw err
    if (err.kind === 'reverted') {
      // the message keeps a short copy for an operator; the field keeps the whole payload for a caller to decode
      const revertData = err.revertData ?? '0x'
      return {
        reason: `eth_estimateGas reverted once the dependency was confirmed: ${short(revertData)}`,
        revertData,
      }
    }
    // a definitive refusal that isn't a revert (insufficient balance, gas above the block limit, ...): retrying
    // the estimate will not clear it either, so this is the same dead end as a revert
    if (err.kind === 'failed') return { reason: describeError(err) }
    throw err
  }
}
