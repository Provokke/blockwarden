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
  // asks every RPC URL: undefined only when all of them answered that there is no receipt, and throws when none had
  // it but one could not answer
  findReceipt(hash: Hex): Promise<Receipt | undefined>
  // whether the node knows the transaction at all, pending or mined
  isKnown(hash: Hex): Promise<boolean>
  send(raw: Hex): Promise<SendOutcome>
}

// The JSON-RPC error a node answered with, if it answered at all.
function rpcAnswer(err: unknown): RpcRequestError | undefined {
  const found = err instanceof BaseError ? err.walk((e) => e instanceof RpcRequestError) : null
  return found instanceof RpcRequestError ? found : undefined
}

// A node's answer is stored on the transaction item and logged, and some echo the whole raw transaction back, so
// this is as much of one as either can afford. The 1 KB the reviewer measured put a full item at 392 KB.
const MAX_ERROR_CHARS = 256

function short(text: string): string {
  return text.length <= MAX_ERROR_CHARS ? text : `${text.slice(0, MAX_ERROR_CHARS - 3)}...`
}

// The node's own words, else viem's short messages. Never the full message: it repeats the raw transaction and can
// carry the RPC URL with its API key.
export function describeError(err: unknown): string {
  const answer = rpcAnswer(err)
  // a node can answer with no "message" field, or with "error" as a bare string; details is then undefined and the
  // chain below still has viem's own shortMessage to fall back on
  if (answer?.details) return short(answer.details)
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; current && depth < 8; depth++) {
    const e = current as { details?: unknown; shortMessage?: unknown; message?: unknown; cause?: unknown }
    const own = current instanceof BaseError ? [e.shortMessage, e.details] : [e.message]
    for (const part of own) if (typeof part === 'string' && part && !parts.includes(part)) parts.push(part)
    current = e.cause
  }
  return short(parts.join(' | '))
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

// viem files geth's "gas required exceeds allowance" as a revert too, so a node's answer counts only with its revert
// code or its own "execution reverted"
function isRevertAnswer(err: unknown): boolean {
  const answer = rpcAnswer(err)
  if (answer) return answer.code === 3 || /execution reverted/i.test(answer.details ?? '')
  return err instanceof BaseError && err.walk((e) => e instanceof ExecutionRevertedError) !== null
}

// Node messages are the only stable signal: geth, op-geth, Nitro and Anvil share most of them, and viem's own
// error classes lump "already known" together with "nonce too low".
export function classifySendError(err: unknown): SendOutcome {
  // the patterns below all sit at the front of a node's answer, so the shortened message still classifies
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
    if (isRevertAnswer(err)) {
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

export type RelayerChainOptions = {
  // per request to one URL
  timeoutMs?: number
  // tries of one URL after the first before moving to the next; viem retries a timeout too
  retryCount?: number
}

export function createRelayerChain(
  chainId: number,
  rpcUrls: string[],
  { timeoutMs = 10_000, retryCount = 1 }: RelayerChainOptions = {},
): RelayerChain {
  if (rpcUrls.length === 0) throw new Error(`no RPC URLs for chain ${chainId}`)
  const clientWith = (shouldThrow?: (err: Error) => boolean): PublicClient =>
    createPublicClient({
      transport: fallback(
        rpcUrls.map((url) => http(url, { timeout: timeoutMs, retryCount })),
        { retryCount: 0, shouldThrow },
      ),
      // viem otherwise caches the block number, and the sweeper compares heads between calls
      cacheTime: 0,
    })
  // reads keep viem's default and try the next URL, which helps when one node lags behind
  const client = clientWith()
  // a lagging node's null receipt is an answer, so the fallback never moves on from it; findReceipt asks each URL itself
  const perUrl = rpcUrls.map((url) =>
    createPublicClient({ transport: http(url, { timeout: timeoutMs, retryCount }), cacheTime: 0 }),
  )
  const receiptFrom = async (reader: PublicClient, hash: Hex): Promise<Receipt | undefined> => {
    try {
      const receipt = await reader.getTransactionReceipt({ hash })
      return { hash, blockNumber: Number(receipt.blockNumber), blockHash: receipt.blockHash, status: receipt.status }
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) return undefined
      throw err
    }
  }
  // only a refusal or a revert stops the fallback; a node that could not serve the call just passes it to the next URL
  const decisiveSend = clientWith((err) => classifySendError(err).kind !== 'unknown')
  const decisiveEstimate = clientWith((err) => isRevertAnswer(err) || classifySendError(err).kind !== 'unknown')

  return {
    chainId,
    async estimateGas({ from, to, data, value }) {
      try {
        return await decisiveEstimate.estimateGas({ account: from, to, data, value })
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
      return receiptFrom(client, hash)
    },
    async findReceipt(hash) {
      const answers = await Promise.allSettled(perUrl.map((reader) => receiptFrom(reader, hash)))
      for (const answer of answers) if (answer.status === 'fulfilled' && answer.value) return answer.value
      const failure = answers.find((answer) => answer.status === 'rejected')
      if (failure) throw failure.reason
      return undefined
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
        await decisiveSend.sendRawTransaction({ serializedTransaction: raw })
        return { kind: 'accepted' }
      } catch (err) {
        return classifySendError(err)
      }
    },
  }
}
