import { toDigestSignerAccount } from '@blockwarden/kms-signer'
import { createLocalDigestSigner } from '@blockwarden/kms-signer/testing'
import type { Address, Hex, LocalAccount } from 'viem'
import type { TxQueue } from '../../src/queue.js'
import type { SignerRecord, TxRecord } from '../../src/records.js'

export const TARGET: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
export const SIGNER_KEY: Hex = `0x${'4c'.repeat(32)}`
export const CHAIN_ID = 84532

export function signerRecord(overrides: Partial<SignerRecord> = {}): SignerRecord {
  return {
    signerId: 'billing',
    keyId: 'local',
    chainIds: [CHAIN_ID],
    policy: {
      allowedTo: [{ address: TARGET }],
      maxGasLimit: 1_000_000,
      maxFeePerGas: '100000000000',
      maxPriorityFeePerGas: '10000000000',
      dailySpendCapWei: '1000000000000000000',
    },
    ...overrides,
  }
}

// the in-process stand-in for a KMS key, behind the same interface the Lambda uses
export function localAccount(privateKey: Hex = SIGNER_KEY): Promise<LocalAccount> {
  return toDigestSignerAccount(createLocalDigestSigner(privateKey))
}

export class RecordingQueue implements TxQueue {
  sent: { txId: string; enqueues: number }[] = []
  failNext = false

  async send(tx: TxRecord): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('queue unavailable')
    }
    this.sent.push({ txId: tx.txId, enqueues: tx.enqueues })
  }
}

export function queuedTx(from: Address, overrides: Partial<TxRecord> = {}): TxRecord {
  const at = '2026-09-17T00:00:00.000Z'
  return {
    txId: `tx-${Math.random().toString(16).slice(2)}`,
    kind: 'relay',
    signerId: 'billing',
    chainId: CHAIN_ID,
    from,
    to: TARGET,
    data: '0x',
    value: '0',
    gasLimit: '60000',
    status: 'queued',
    attempts: [],
    idempotencyKey: `key-${Math.random().toString(16).slice(2)}`,
    apiKeyHash: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    enqueuedAt: Date.parse(at),
    enqueues: 1,
    history: [{ status: 'queued', at }],
    createdAt: at,
    updatedAt: at,
    version: 1,
    ...overrides,
  }
}

// for tests that build a TxRecord without caring about the sender address
export function txRecord(overrides: Partial<TxRecord> = {}): TxRecord {
  return queuedTx(overrides.from ?? TARGET, overrides)
}
