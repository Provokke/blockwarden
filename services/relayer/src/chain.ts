import type { Fees } from '@blockwarden/core'
import {
  BaseError,
  createPublicClient,
  ExecutionRevertedError,
  fallback,
  http,
  HttpRequestError,
  RpcRequestError,
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

// The JSON-RPC error a node answered with, if it answered at all.
function rpcAnswer(err: unknown): RpcRequestError | undefined {
  const found = err instanceof BaseError ? err.walk((e) => e instanceof RpcRequestError) : null
  return found instanceof RpcRequestError ? found : undefined
}

// The node's own words when it answered, else viem's short messages. Never a BaseError's full message: that repeats
// the request body, which for a send is the whole raw transaction.
function describeError(err: unknown): string {
  const answer = rpcAnswer(err)
  if (answer) return answer.details
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; current && depth < 8; depth++) {
    const e = current as { details?: unknown; shortMessage?: unknown; message?: unknown; cause?: unknown }
    const own = current instanceof BaseError ? [e.shortMessage, e.details] : [e.message]
    for (const part of own) if (typeof part === 'string' && part && !parts.includes(part)) parts.push(part)
    current = e.cause
  }
  return parts.join(' | ')
}

// -32005 is the JSON-RPC limit-exceeded code; some providers put 429 in the body as the code instead
function isRateLimit(err: unknown): boolean {
  const code = rpcAnswer(err)?.code
  return code === -32005 || code === 429
}

function isTransportError(err: unknown): boolean {
  return err instanceof BaseError
    ? Boolean(err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError))
    : false
}

// Node messages are the only stable signal: geth, op-geth, Nitro and Anvil share most of them, and viem's own
// error classes lump "already known" together with "nonce too low".
export function classifySendError(err: unknown): SendOutcome {
  const message = describeError(err)
  if (isTransportError(err)) return { kind: 'unknown', message }
  const text = message.toLowerCase()
  if (/already known|already imported|known transaction/.test(text)) return { kind: 'already-known' }
  if (/nonce too low|nonce has already been used/.test(text)) return { kind: 'nonce-too-low', message }
  if (
    /replacement transaction underpriced|transaction underpriced|gas price below minimum|max fee per gas less than block base fee|fee too low/.test(
      text,
    )
  ) {
    return { kind: 'underpriced', message }
  }
  if (/insufficient funds/.test(text)) return { kind: 'insufficient-funds', message }
  if (
    /intrinsic gas too (low|high)|floor data gas cost|transaction type not supported|exceeds block gas limit|gas limit too high|invalid chain id|invalid sender|oversized data|exceeds the configured cap|higher than max fee per gas|tip higher than fee cap/.test(
      text,
    )
  ) {
    return { kind: 'rejected', message }
  }
  // "nonce too high" stays unknown on purpose: the gap closes as earlier nonces land, and a filler would fail too
  return { kind: 'unknown', message }
}

export function classifyEstimateError(err: unknown): EstimateError {
  if (isTransportError(err)) return new EstimateError('unavailable', 'the RPC did not answer the gas estimate')
  if (isRateLimit(err)) return new EstimateError('unavailable', 'the RPC rate-limited the gas estimate')
  if (err instanceof BaseError) {
    // viem also files geth's "gas required exceeds allowance" under ExecutionRevertedError, so when a node answered,
    // only its revert code or its own "execution reverted" counts
    const answer = rpcAnswer(err)
    const reverted = answer
      ? answer.code === 3 || /execution reverted/i.test(answer.details)
      : err.walk((e) => e instanceof ExecutionRevertedError)
    if (reverted) {
      const withData = err.walk((e) => typeof (e as { data?: unknown }).data === 'string') as { data?: string } | null
      const data = withData?.data
      return new EstimateError(
        'reverted',
        'eth_estimateGas reverted',
        typeof data === 'string' && /^0x[0-9a-fA-F]*$/.test(data) ? (data as Hex) : '0x',
      )
    }
    return new EstimateError('failed', describeError(err))
  }
  return new EstimateError('failed', err instanceof Error ? err.message : String(err))
}

export function createRelayerChain(chainId: number, rpcUrls: string[], timeoutMs = 10_000): RelayerChain {
  if (rpcUrls.length === 0) throw new Error(`no RPC URLs for chain ${chainId}`)
  const clientWith = (shouldThrow?: (err: Error) => boolean): PublicClient =>
    createPublicClient({
      transport: fallback(
        rpcUrls.map((url) => http(url, { timeout: timeoutMs, retryCount: 1 })),
        { retryCount: 0, shouldThrow },
      ),
      // viem otherwise caches the block number, and the sweeper compares heads between calls
      cacheTime: 0,
    })
  // reads keep viem's default and try the next URL, which helps when one node lags behind
  const client = clientWith()
  // A node's refusal of a send or an estimate is an answer, but viem's default walks on past geth's -32000 refusals, so
  // the last URL's answer, or its timeout, would replace it. Only transport failures and rate limits move on.
  const decisive = clientWith((err) => rpcAnswer(err) !== undefined && !isRateLimit(err))

  return {
    chainId,
    async estimateGas({ from, to, data, value }) {
      try {
        return await decisive.estimateGas({ account: from, to, data, value })
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
        await decisive.sendRawTransaction({ serializedTransaction: raw })
        return { kind: 'accepted' }
      } catch (err) {
        return classifySendError(err)
      }
    },
  }
}
