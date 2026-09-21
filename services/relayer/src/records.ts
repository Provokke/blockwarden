import type { RelayerTxBody, TxKind, TxStatus } from '@blockwarden/relayer-client'
import type { Address, Hex } from 'viem'
import type { Policy } from './policy.js'

export type SignerRecord = {
  signerId: string
  keyId: string
  chainIds: number[]
  policy: Policy
  // read by the actions pipeline in milestone 3
  webhooks?: string[]
  webhookSecretParameter?: string
}

// keys made by the script carry createdAt; keys made by Terraform do not
export type ApiKeyRecord = { hash: string; signerIds: string[]; label: string; createdAt?: string }

export type Attempt = {
  hash: Hex
  // '0x' once the sweeper dropped the bytes of an old refused attempt to keep the item small
  raw: Hex
  maxFeePerGas: string
  maxPriorityFeePerGas: string
  signedAt: number
  // when the node took this attempt on a rebroadcast after refusing it; the stuck clock runs from here
  broadcastAt?: number
  // when a node took this signature, or may have (an unclassified answer or a timeout); it can still be mined after
  // a later refusal
  acceptedAt?: number
  // the node's answer when it refused this signature outright
  rejected?: string
}

export type MinedRecord = { hash: Hex; blockNumber: number; blockHash: Hex; status: 'success' | 'reverted' }

export type TxRecord = {
  txId: string
  kind: TxKind
  signerId: string
  chainId: number
  from: Address
  to: Address
  data: Hex
  value: string
  gasLimit: string
  status: TxStatus
  nonce?: number
  attempts: Attempt[]
  // the newest signatures at a nonce this tx gave up after nonce too low, kept as evidence without their bytes;
  // nothing rebroadcasts them
  abandonedAttempts?: (Attempt & { nonce: number })[]
  // hashes of refused attempts the sweeper dropped to make room; a node may have taken one before refusing it, so
  // receipts are still looked up for them
  retiredHashes?: Hex[]
  // a node took one of the dropped attempts, so it can still be mined
  retiredAccepted?: boolean
  // retiredHashes is full, so the sweeper signs nothing more for this transaction and only rebroadcasts; never cleared
  retiredHashesFull?: boolean
  // how far the last sweep got through this transaction's hashes, so the next one carries on instead of starting
  // over; the two walks count separately, and a finished walk clears it
  lookupFrom?: { walk: 'receipts' | 'all-urls'; index: number }
  // the node refused the last signature as underpriced, so the sweeper replaces it without waiting
  needsBump?: boolean
  // the policy fee cap is below the node's replacement minimum, so the sweeper can only rebroadcast
  feeCapReached?: boolean
  mined?: MinedRecord
  // the head, and the time, when the sweeper first saw this nonce used without a receipt for any of our hashes
  nonceUsedAtBlock?: number
  nonceUsedAt?: string
  error?: string
  // the raw revert data a node returned for a call that reverts; set by the signer in Task 4
  revertData?: Hex
  fillerTxId?: string
  fillsTxId?: string
  dependsOn?: string
  idempotencyKey?: string
  reference?: string
  apiKeyHash?: string
  requestHash?: string
  enqueuedAt: number
  enqueues: number
  // how many status changes were dropped off the front of history; a delivery's seq counts from here, so the
  // second tx.mined after a reorg is never the same delivery as the first
  historyBase?: number
  history: { status: TxStatus; at: string }[]
  createdAt: string
  updatedAt: string
  version: number
}

export const SETTLED: ReadonlySet<TxStatus> = new Set(['confirmed', 'failed', 'cancelled'])

export function latestAttempt(tx: TxRecord): Attempt | undefined {
  return tx.attempts.at(-1)
}

// the newest signature the node did not refuse, which is the one worth rebroadcasting
export function liveAttempt(tx: TxRecord): Attempt | undefined {
  return tx.attempts.findLast((a) => a.rejected === undefined)
}

// marks every copy of this signature as taken by a node, keeping the first time
export function markAccepted(attempts: Attempt[], hash: Hex, at: number): Attempt[] {
  return attempts.map((a) => (a.hash === hash && a.acceptedAt === undefined ? { ...a, acceptedAt: at } : a))
}

export function toTxBody(tx: TxRecord): RelayerTxBody {
  return {
    txId: tx.txId,
    kind: tx.kind,
    signerId: tx.signerId,
    chainId: tx.chainId,
    from: tx.from,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gasLimit: tx.gasLimit,
    status: tx.status,
    nonce: tx.nonce ?? null,
    hash: tx.mined?.hash ?? latestAttempt(tx)?.hash ?? null,
    blockNumber: tx.mined?.blockNumber ?? null,
    blockHash: tx.mined?.blockHash ?? null,
    receiptStatus: tx.mined?.status ?? null,
    error: tx.error ?? null,
    revertData: tx.revertData ?? null,
    fillerTxId: tx.fillerTxId ?? null,
    idempotencyKey: tx.idempotencyKey ?? null,
    reference: tx.reference ?? null,
    dependsOn: tx.dependsOn ?? null,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
  }
}

export type DependencyState = 'ready' | 'waiting' | 'unsuccessful'

// a dependency counts once it is confirmed, because a merely mined one can still be reorged out
export function dependencyState(dependency: TxRecord | undefined): DependencyState {
  if (!dependency) return 'unsuccessful'
  if (dependency.status === 'confirmed') return dependency.mined?.status === 'success' ? 'ready' : 'unsuccessful'
  if (dependency.status === 'failed' || dependency.status === 'cancelled') return 'unsuccessful'
  return 'waiting'
}

// A reorg can flip a transaction between mined and submitted any number of times. 64 entries is more history
// than an operator reads and keeps the array from growing without bound.
export const MAX_HISTORY = 64

export function historyCount(tx: Pick<TxRecord, 'history' | 'historyBase'>): number {
  return (tx.historyBase ?? 0) + tx.history.length
}

export function historyEntries(
  tx: Pick<TxRecord, 'history' | 'historyBase'>,
): { seq: number; status: TxStatus; at: string }[] {
  const base = tx.historyBase ?? 0
  return tx.history.map((entry, i) => ({ seq: base + i, ...entry }))
}

export function withStatus(tx: TxRecord, status: TxRecord['status'], at: string): TxRecord {
  if (tx.status === status) return tx
  const history = [...tx.history, { status, at }]
  if (history.length <= MAX_HISTORY) return { ...tx, status, history }
  const dropped = history.length - MAX_HISTORY
  return { ...tx, status, history: history.slice(dropped), historyBase: (tx.historyBase ?? 0) + dropped }
}
