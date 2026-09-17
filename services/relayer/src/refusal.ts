import type { Address, Hex } from 'viem'
import type { RelayerChain } from './chain.js'
import type { TxQueue } from './queue.js'
import { withStatus, type TxRecord } from './records.js'
import type { RelayerStore } from './store.js'

export type RefusalDeps = {
  store: RelayerStore
  queue: TxQueue
  now(): Date
  newTxId(): string
  log(message: string, data?: Record<string, unknown>, level?: 'warn' | 'error'): void
}

// A transaction the node refuses outright never uses its nonce, and every later nonce waits behind the gap.
// A 0-value transfer to itself takes the nonce instead. A filler that is itself refused gets no filler of its own.
export async function failRefused(
  deps: RefusalDeps,
  chain: RelayerChain,
  tx: TxRecord,
  refusedHash: Hex,
  from: Address,
  reason: string,
): Promise<void> {
  const at = deps.now().toISOString()
  const attempts = tx.attempts.map((a) => (a.hash === refusedHash ? { ...a, rejected: reason } : a))
  const failed: TxRecord = { ...withStatus(tx, 'failed', at), attempts, error: reason }
  if (tx.kind === 'filler') {
    await deps.store.saveTx(failed, at)
    deps.log('filler refused; the nonce stays open', { txId: tx.txId, nonce: tx.nonce, reason }, 'warn')
    return
  }
  // an L2 transfer can need more than 21000 gas, so the filler is estimated like any other transaction
  const gas = await chain.estimateGas({ from, to: from, data: '0x', value: 0n })
  const filler: TxRecord = {
    txId: deps.newTxId(),
    kind: 'filler',
    signerId: tx.signerId,
    chainId: tx.chainId,
    from,
    to: from,
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
    deps.log(
      'enqueue of filler failed; the sweeper will requeue it',
      { txId: filler.txId, error: (err as Error).message },
      'warn',
    )
  }
}
