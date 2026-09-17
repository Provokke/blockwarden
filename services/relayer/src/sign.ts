import type { Fees } from '@blockwarden/core'
import { keccak256, type LocalAccount } from 'viem'
import type { Attempt, TxRecord } from './records.js'

export async function signAttempt(account: LocalAccount, tx: TxRecord, fees: Fees, nowMs: number): Promise<Attempt> {
  if (tx.nonce === undefined) throw new Error(`transaction ${tx.txId} has no nonce to sign with`)
  const raw = await account.signTransaction({
    type: 'eip1559',
    chainId: tx.chainId,
    nonce: tx.nonce,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value),
    gas: BigInt(tx.gasLimit),
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  })
  return {
    hash: keccak256(raw),
    raw,
    maxFeePerGas: fees.maxFeePerGas.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
    signedAt: nowMs,
  }
}

export function attemptFees(attempt: Attempt): Fees {
  return { maxFeePerGas: BigInt(attempt.maxFeePerGas), maxPriorityFeePerGas: BigInt(attempt.maxPriorityFeePerGas) }
}
