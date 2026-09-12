import type { Fees } from '@blockwarden/core'
import type { Address, Hex } from 'viem'
import { EstimateError, type Receipt, type RelayerChain, type SendOutcome } from '../../src/chain.js'

// A scripted chain: each answer is set by the test, and every call is recorded so a test can assert what the
// code under test asked for, not only what it stored.
export class FakeChain implements RelayerChain {
  readonly chainId: number
  head = 100
  fees: Fees = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }
  gas = 50_000n
  estimateFailure: EstimateError | undefined
  nonces = { latest: 0, pending: 0 }
  balances = new Map<string, bigint>()
  receipts = new Map<Hex, Receipt>()
  // the other RPC URLs, which only findReceipt asks; a node with a failure errors instead of answering
  otherNodes: { receipts: Map<Hex, Receipt>; failure?: Error }[] = []
  known = new Set<Hex>()
  // answers for send, used in order; once used up every send is accepted
  sendOutcomes: SendOutcome[] = []
  sent: Hex[] = []
  // runs before a send is answered, so a test can look at the store as the bytes go out
  onSend: ((raw: Hex) => Promise<void>) | undefined
  calls: string[] = []

  constructor(chainId = 84532) {
    this.chainId = chainId
  }

  async estimateGas(_request: { from: Address; to: Address; data: Hex; value: bigint }): Promise<bigint> {
    this.calls.push('estimateGas')
    if (this.estimateFailure) throw this.estimateFailure
    return this.gas
  }

  async estimateFees(): Promise<Fees> {
    this.calls.push('estimateFees')
    return this.fees
  }

  async getNonce(_address: Address, blockTag: 'latest' | 'pending'): Promise<number> {
    this.calls.push(`getNonce:${blockTag}`)
    return this.nonces[blockTag]
  }

  async getBalance(address: Address): Promise<bigint> {
    this.calls.push('getBalance')
    return this.balances.get(address.toLowerCase()) ?? 0n
  }

  async getBlockNumber(): Promise<number> {
    return this.head
  }

  async getReceipt(hash: Hex): Promise<Receipt | undefined> {
    this.calls.push(`getReceipt:${hash}`)
    return this.receipts.get(hash)
  }

  async findReceipt(hash: Hex): Promise<Receipt | undefined> {
    this.calls.push(`findReceipt:${hash}`)
    const found =
      this.receipts.get(hash) ?? this.otherNodes.find((n) => !n.failure && n.receipts.has(hash))?.receipts.get(hash)
    if (found) return found
    const failed = this.otherNodes.find((n) => n.failure)
    if (failed) throw failed.failure
    return undefined
  }

  async isKnown(hash: Hex): Promise<boolean> {
    this.calls.push(`isKnown:${hash}`)
    return this.known.has(hash)
  }

  async send(raw: Hex): Promise<SendOutcome> {
    this.sent.push(raw)
    await this.onSend?.(raw)
    return this.sendOutcomes.shift() ?? { kind: 'accepted' }
  }

  mine(hash: Hex, blockNumber = this.head, status: Receipt['status'] = 'success'): Receipt {
    const receipt = receiptAt(hash, blockNumber, status)
    this.receipts.set(hash, receipt)
    return receipt
  }
}

export function receiptAt(hash: Hex, blockNumber: number, status: Receipt['status'] = 'success'): Receipt {
  return { hash, blockNumber, blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}` as Hex, status }
}
