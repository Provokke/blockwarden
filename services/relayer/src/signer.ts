import { clampFees } from '@blockwarden/core'
import type { LocalAccount } from 'viem'
import type { RelayerChain } from './chain.js'
import { feeCap } from './policy.js'
import type { TxQueue } from './queue.js'
import { latestAttempt, withStatus, type SignerRecord, type TxRecord } from './records.js'
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
  log(message: string, data?: Record<string, unknown>): void
}

export type ProcessOutcome = 'missing' | 'skipped' | 'paused' | 'submitted' | 'failed'

// a nonce taken by another sender forces a fresh one; twice in a row means something else keeps sending
const MAX_NONCE_RESETS = 2

export async function processTx(deps: SignerDeps, txId: string): Promise<ProcessOutcome> {
  const { store } = deps
  const stamp = () => deps.now().toISOString()
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

  for (let resets = 0; ; resets++) {
    if (tx.nonce === undefined) {
      // on a cold start the counter may be behind the chain, for example after a key was used elsewhere
      if (!deps.reconciled.has(pair)) {
        await store.raiseNonce(signer.signerId, tx.chainId, await chain.getNonce(account.address, 'pending'))
        deps.reconciled.add(pair)
      }
      tx = await store.assignNonce(tx, stamp())
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
      case 'unknown':
        await store.saveTx(withStatus(tx, 'submitted', stamp()), stamp())
        return 'submitted'

      case 'underpriced': {
        // below the base fee or the node's minimum: the sweeper replaces it on its next run
        const attempts = tx.attempts.map((a) => (a.hash === attempt.hash ? { ...a, rejected: outcome.message } : a))
        await store.saveTx({ ...withStatus(tx, 'submitted', stamp()), attempts, needsBump: true }, stamp())
        return 'submitted'
      }

      case 'insufficient-funds': {
        const requiredWei = BigInt(tx.value) + BigInt(tx.gasLimit) * BigInt(attempt.maxFeePerGas)
        await store.pause({
          signerId: signer.signerId,
          chainId: tx.chainId,
          address: account.address,
          requiredWei: requiredWei.toString(),
          since: stamp(),
        })
        deps.log('signer paused: insufficient funds', { signerId: signer.signerId, chainId: tx.chainId, txId })
        return 'paused'
      }

      case 'nonce-too-low': {
        for (const a of tx.attempts) {
          if (await chain.getReceipt(a.hash)) {
            await store.saveTx(withStatus(tx, 'submitted', stamp()), stamp())
            return 'submitted'
          }
        }
        if (resets >= MAX_NONCE_RESETS) throw new Error(`transaction ${txId} kept hitting nonce too low`)
        // another sender used this nonce: give it up and take the next one after reconciling
        deps.reconciled.delete(pair)
        const { nonce: _nonce, ...rest } = tx
        tx = await store.saveTx({ ...rest, attempts: [] }, stamp())
        continue
      }

      case 'rejected':
        return fail(deps, tx, account, outcome.message, chain)
    }
  }
}

// A transaction the node refuses outright never uses its nonce, and every later nonce waits behind the gap.
// A 0-value transfer to itself takes the nonce instead. A filler that is itself refused gets no filler of its own.
async function fail(
  deps: SignerDeps,
  tx: TxRecord,
  account: LocalAccount,
  reason: string,
  chain: RelayerChain,
): Promise<ProcessOutcome> {
  const at = deps.now().toISOString()
  const attempts = tx.attempts.map((a, i) => (i === tx.attempts.length - 1 ? { ...a, rejected: reason } : a))
  const failed: TxRecord = { ...withStatus(tx, 'failed', at), attempts, error: reason }
  if (tx.kind === 'filler') {
    await deps.store.saveTx(failed, at)
    deps.log('filler refused; the nonce stays open', { txId: tx.txId, nonce: tx.nonce, reason })
    return 'failed'
  }
  // an L2 transfer can need more than 21000 gas, so the filler is estimated like any other transaction
  const gas = await chain.estimateGas({ from: account.address, to: account.address, data: '0x', value: 0n })
  const filler: TxRecord = {
    txId: deps.newTxId(),
    kind: 'filler',
    signerId: tx.signerId,
    chainId: tx.chainId,
    from: account.address,
    to: account.address,
    data: '0x',
    value: '0',
    gasLimit: ((gas * 120n) / 100n).toString(),
    status: 'queued',
    nonce: tx.nonce!,
    attempts: [],
    fillsTxId: tx.txId,
    enqueuedAt: deps.now().getTime(),
    enqueues: 1,
    history: [{ status: 'queued', at }],
    createdAt: at,
    updatedAt: at,
    version: 1,
  }
  await deps.store.failWithFiller({ ...failed, fillerTxId: filler.txId }, filler, at)
  try {
    await deps.queue.send(filler)
  } catch (err) {
    deps.log('enqueue of filler failed; the sweeper will requeue it', {
      txId: filler.txId,
      error: (err as Error).message,
    })
  }
  return 'failed'
}
