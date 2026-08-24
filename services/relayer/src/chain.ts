import type { Fees } from '@blockwarden/core'
import {
  BaseError,
  createPublicClient,
  ExecutionRevertedError,
  fallback,
  http,
  HttpRequestError,
  TimeoutError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

export type Receipt = { hash: Hex; blockNumber: number; blockHash: Hex; status: 'success' | 'reverted' }

export type SendOutcome =
  | { kind: 'accepted' }
  | { kind: 'already-known' }
  | { kind: 'nonce-too-low'; message: string }
  | { kind: 'underpriced'; message: string }
  | { kind: 'insufficient-funds'; message: string }
  // the node refused the transaction for a reason no fee or nonce change fixes
  | { kind: 'rejected'; message: string }
  // a timeout or an answer we cannot classify: the transaction may have been accepted
  | { kind: 'unknown'; message: string }

export class EstimateError extends Error {
  constructor(
    readonly kind: 'reverted' | 'failed' | 'unavailable',
    message: string,
    readonly revertData?: Hex,
  ) {
    super(message)
    this.name = 'EstimateError'
  }
}

export interface RelayerChain {
  readonly chainId: number
  estimateGas(request: { from: Address; to: Address; data: Hex; value: bigint }): Promise<bigint>
  estimateFees(): Promise<Fees>
  getNonce(address: Address, blockTag: 'latest' | 'pending'): Promise<number>
  getBalance(address: Address): Promise<bigint>
  getBlockNumber(): Promise<number>
  getReceipt(hash: Hex): Promise<Receipt | undefined>
  // whether the node knows the transaction at all, pending or mined
  isKnown(hash: Hex): Promise<boolean>
  send(raw: Hex): Promise<SendOutcome>
}

function messages(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; current && depth < 8; depth++) {
    const e = current as { details?: unknown; shortMessage?: unknown; message?: unknown; cause?: unknown }
    for (const part of [e.details, e.shortMessage, e.message]) if (typeof part === 'string') parts.push(part)
    current = e.cause
  }
  return parts.join(' | ').toLowerCase()
}

function isTransportError(err: unknown): boolean {
  return err instanceof BaseError
    ? Boolean(err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError))
    : false
}

// Node messages are the only stable signal: geth, op-geth, Nitro and Anvil share most of them, and viem's own
// error classes lump "already known" together with "nonce too low".
export function classifySendError(err: unknown): SendOutcome {
  if (isTransportError(err)) return { kind: 'unknown', message: messages(err) }
  const text = messages(err)
  if (/already known|already imported|known transaction/.test(text)) return { kind: 'already-known' }
  if (/nonce too low|nonce has already been used/.test(text)) return { kind: 'nonce-too-low', message: text }
  if (
    /replacement transaction underpriced|transaction underpriced|max fee per gas less than block base fee|fee too low/.test(
      text,
    )
  ) {
    return { kind: 'underpriced', message: text }
  }
  if (/insufficient funds/.test(text)) return { kind: 'insufficient-funds', message: text }
  if (
    /intrinsic gas too (low|high)|exceeds block gas limit|gas limit too high|invalid chain id|invalid sender|oversized data|exceeds the configured cap|higher than max fee per gas|tip higher than fee cap/.test(
      text,
    )
  ) {
    return { kind: 'rejected', message: text }
  }
  return { kind: 'unknown', message: text }
}

export function classifyEstimateError(err: unknown): EstimateError {
  if (isTransportError(err)) return new EstimateError('unavailable', 'the RPC did not answer the gas estimate')
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ExecutionRevertedError)
    if (reverted) {
      const withData = err.walk((e) => typeof (e as { data?: unknown }).data === 'string') as { data?: string } | null
      const data = withData?.data
      return new EstimateError(
        'reverted',
        'eth_estimateGas reverted',
        typeof data === 'string' && /^0x[0-9a-fA-F]*$/.test(data) ? (data as Hex) : '0x',
      )
    }
    return new EstimateError('failed', err.shortMessage)
  }
  return new EstimateError('failed', err instanceof Error ? err.message : String(err))
}

export function createRelayerChain(chainId: number, rpcUrls: string[], timeoutMs = 10_000): RelayerChain {
  if (rpcUrls.length === 0) throw new Error(`no RPC URLs for chain ${chainId}`)
  const client: PublicClient = createPublicClient({
    transport: fallback(
      rpcUrls.map((url) => http(url, { timeout: timeoutMs, retryCount: 1 })),
      { retryCount: 0 },
    ),
    // viem otherwise caches the block number, and the sweeper compares heads between calls
    cacheTime: 0,
  })

  return {
    chainId,
    async estimateGas({ from, to, data, value }) {
      try {
        return await client.estimateGas({ account: from, to, data, value })
      } catch (err) {
        throw classifyEstimateError(err)
      }
    },
    async estimateFees() {
      const { maxFeePerGas, maxPriorityFeePerGas } = await client.estimateFeesPerGas()
      return { maxFeePerGas, maxPriorityFeePerGas }
    },
    async getNonce(address, blockTag) {
      return client.getTransactionCount({ address, blockTag })
    },
    async getBalance(address) {
      return client.getBalance({ address })
    },
    async getBlockNumber() {
      return Number(await client.getBlockNumber())
    },
    async getReceipt(hash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash })
        return {
          hash,
          blockNumber: Number(receipt.blockNumber),
          blockHash: receipt.blockHash,
          status: receipt.status,
        }
      } catch (err) {
        if (err instanceof TransactionReceiptNotFoundError) return undefined
        throw err
      }
    },
    async isKnown(hash) {
      try {
        await client.getTransaction({ hash })
        return true
      } catch (err) {
        if (err instanceof TransactionNotFoundError) return false
        throw err
      }
    },
    async send(raw) {
      try {
        await client.sendRawTransaction({ serializedTransaction: raw })
        return { kind: 'accepted' }
      } catch (err) {
        return classifySendError(err)
      }
    },
  }
}
