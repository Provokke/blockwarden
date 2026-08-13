import { DeadlineError, type LogFilter, type RawLog } from '@blockwarden/core'
import {
  createPublicClient,
  fallback,
  hexToNumber,
  http,
  HttpRequestError,
  ResponseBodyTooLargeError,
  TimeoutError,
  toHex,
} from 'viem'

export interface ChainReader {
  // absolute epoch milliseconds; every request still running then is aborted and rejects with DeadlineError
  setHardStop(epochMs: number | undefined): void
  // forgets each node's remembered head, so the next log read pre-reads it again
  resetRememberedHeads(): void
  getHead(): Promise<number>
  getFinalized(): Promise<{ number: number; timestamp: number } | undefined>
  getLogs(filter: LogFilter, from: number, to: number): Promise<RawLog[]>
  getLogsWithHead(
    filter: LogFilter,
    from: number,
    to: number,
    options?: { shouldStop?: () => boolean },
  ): Promise<{ logs: RawLog[]; head: number; headBefore: number }>
}

export class LaggingNodeError extends Error {
  readonly head: number
  readonly to: number

  constructor(head: number, to: number) {
    super(`RPC node head ${head} is behind the requested range end ${to}`)
    this.name = 'LaggingNodeError'
    this.head = head
    this.to = to
  }
}

export class HeadReadError extends Error {
  constructor(cause: unknown) {
    super(
      `reading the RPC node head for its log request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    )
    this.name = 'HeadReadError'
  }
}

// the node refused the method or the request itself, so a smaller range would be refused the same way
const NOT_HALVABLE_CODES = new Set([-32601, -32004, -32600, -32700])

function isTransportError(err: unknown): boolean {
  return err instanceof HttpRequestError || err instanceof TimeoutError
}

export function isJsonRpcError(err: unknown): boolean {
  return !(isTransportError(err) || err instanceof LaggingNodeError || err instanceof DeadlineError)
}

export function isHalvableError(err: unknown): boolean {
  // a failed head read says nothing about the log range
  if (!isJsonRpcError(err) || err instanceof HeadReadError) return false
  const code = (err as { code?: unknown } | null | undefined)?.code
  return !(typeof code === 'number' && NOT_HALVABLE_CODES.has(code))
}

const NULL_BODY_STATUSES = new Set([204, 205, 304])

// viem's default limit; it can only apply it to a body this fetch has already read, so the limit is enforced here too
export const MAX_RESPONSE_BODY_BYTES = 10_485_760

async function readBodyWithinLimit(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get('content-length'))
  if (declared > MAX_RESPONSE_BODY_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new ResponseBodyTooLargeError({ maxSize: MAX_RESPONSE_BODY_BYTES, size: declared })
  }
  const chunks: Uint8Array[] = []
  let size = 0
  if (response.body) {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        throw new ResponseBodyTooLargeError({ maxSize: MAX_RESPONSE_BODY_BYTES, size })
      }
      chunks.push(value)
    }
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

// a plain error, so viem wraps it as a transport failure; the reader turns it into a DeadlineError
class HardStopError extends Error {
  constructor() {
    super('the invocation hard stop passed before the RPC request finished')
    this.name = 'HardStopError'
  }
}

// viem's own timeout stops waiting once the headers arrive, so a body that stalls would hang the invocation;
// reading the body here, under one abort signal and a byte limit, bounds the whole request in time and memory
export function boundedFetch(timeoutMs: number, hardStop: () => number | undefined = () => undefined) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const stopAt = hardStop()
    const untilStop = stopAt === undefined ? Number.POSITIVE_INFINITY : stopAt - Date.now()
    if (untilStop <= 0) throw new HardStopError()
    const stoppedEarly = untilStop < timeoutMs
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, untilStop)))
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    try {
      const response = await fetch(input, { ...init, signal })
      const body = await readBodyWithinLimit(response)
      const headers = new Headers(response.headers)
      // the body is already decoded, so its original encoding and length no longer describe it
      headers.delete('content-encoding')
      headers.delete('content-length')
      return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch (err) {
      // viem rethrows it unchanged, and a smaller range can fit under the limit
      if (err instanceof ResponseBodyTooLargeError) throw err
      // a plain error, so viem reports it as a transport failure rather than passing an abort through
      if (timeout.aborted) {
        throw stoppedEarly ? new HardStopError() : new Error(`the RPC request did not finish within ${timeoutMs} ms`)
      }
      throw err
    }
  }
}

// viem wraps the fetch error, so the hard stop is found along the cause chain
function causedByHardStop(err: unknown): boolean {
  let current = err
  for (let depth = 0; current instanceof Error && depth <= 5; depth++) {
    if (current instanceof HardStopError) return true
    current = current.cause
  }
  return false
}

export function createChainReader(rpcUrls: string[], timeoutMs = 10_000): ChainReader {
  if (rpcUrls.length === 0) throw new Error('at least one RPC URL is required')
  let hardStop: number | undefined
  const hardStopPassed = () => hardStop !== undefined && Date.now() >= hardStop
  // any failure once the hard stop has passed is reported as the stop, so the cycle keeps what it committed
  const stoppedBy = (err: unknown) => causedByHardStop(err) || hardStopPassed()
  const hardStopError = () => new DeadlineError('the invocation hard stop passed before the RPC request finished')
  const guarded = async <T>(request: () => Promise<T>): Promise<T> => {
    if (hardStopPassed()) throw hardStopError()
    try {
      return await request()
    } catch (err) {
      throw stoppedBy(err) ? hardStopError() : err
    }
  }
  const fetchFn = boundedFetch(timeoutMs, () => hardStop)
  const client = createPublicClient({
    // each URL gets one retry and the list is walked once, so a dead list costs two request timeouts per URL
    transport: fallback(
      rpcUrls.map((url) => http(url, { timeout: timeoutMs, retryCount: 1, fetchFn })),
      { retryCount: 0 },
    ),
    cacheTime: 0,
  })
  // fallback fails over each call on its own, which would pair one node's head with another node's logs;
  // viem retries each call on its own too, so retries happen per pair in getLogsWithHead
  const nodeClients = rpcUrls.map((url) =>
    createPublicClient({
      transport: http(url, { timeout: timeoutMs, retryCount: 0, batch: true, fetchFn }),
      cacheTime: 0,
    }),
  )
  // the highest head each node has returned to a completed request
  const knownHeads = rpcUrls.map(() => -1)

  const requestLogs = async (
    reader: Pick<typeof client, 'request'>,
    filter: LogFilter,
    from: number,
    to: number,
  ): Promise<RawLog[]> => {
    const logs = await reader.request({
      method: 'eth_getLogs',
      params: [{ address: filter.addresses, topics: [filter.topic0s], fromBlock: toHex(from), toBlock: toHex(to) }],
    })
    return logs.flatMap((l) =>
      l.removed || !l.blockHash || !l.blockNumber || !l.transactionHash || !l.logIndex
        ? []
        : [
            {
              address: l.address,
              topics: [...l.topics],
              data: l.data,
              blockNumber: hexToNumber(l.blockNumber),
              blockHash: l.blockHash,
              transactionHash: l.transactionHash,
              logIndex: hexToNumber(l.logIndex),
            },
          ],
    )
  }

  // called in the same tick as requestLogs, so both still go out in one batch
  const readBatchedHead = async (node: (typeof nodeClients)[number]): Promise<number> => {
    try {
      return hexToNumber(await node.request({ method: 'eth_blockNumber' }))
    } catch (err) {
      // a head the node cannot answer says nothing about the log range, just like a failed pre-read;
      // an oversized body fails the whole batch, and a smaller range can fit
      if (stoppedBy(err) || isTransportError(err) || err instanceof ResponseBodyTooLargeError) throw err
      throw new HeadReadError(err)
    }
  }

  return {
    setHardStop(epochMs) {
      hardStop = epochMs
    },

    resetRememberedHeads() {
      knownHeads.fill(-1)
    },

    getHead: () => guarded(async () => Number(await client.getBlockNumber({ cacheTime: 0 }))),

    getFinalized: () =>
      guarded(async () => {
        try {
          const b = await client.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] })
          return b?.number ? { number: hexToNumber(b.number), timestamp: hexToNumber(b.timestamp) } : undefined
        } catch (err) {
          if (!isJsonRpcError(err)) throw err
          return undefined
        }
      }),

    getLogs: (filter, from, to) => guarded(() => requestLogs(client, filter, from, to)),

    async getLogsWithHead(filter, from, to, options) {
      const rpcErrors: unknown[] = []
      let lastTransportError: unknown
      let headReadError: HeadReadError | undefined
      for (const [i, node] of nodeClients.entries()) {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (options?.shouldStop?.()) throw new DeadlineError()
          if (hardStopPassed()) throw hardStopError()
          try {
            // Erigon runs batch entries concurrently, so its batched head can be read after the logs were;
            // a head from a request that completed before this batch was sent cannot be
            let headBefore = knownHeads[i]!
            if (headBefore < to) {
              try {
                headBefore = hexToNumber(await node.request({ method: 'eth_blockNumber' }))
              } catch (err) {
                // a node that cannot answer its head is skipped; its failure must not make the range halve
                if (stoppedBy(err) || isTransportError(err)) throw err
                headReadError ??= new HeadReadError(err)
                break
              }
              knownHeads[i] = Math.max(knownHeads[i]!, headBefore)
            }
            // issued in the same tick so the batching http transport sends both in one HTTP request, head first
            const [head, logs] = await Promise.all([readBatchedHead(node), requestLogs(node, filter, from, to)])
            knownHeads[i] = Math.max(knownHeads[i]!, head)
            return { logs, head, headBefore }
          } catch (err) {
            // the next node would be cut off the same way
            if (stoppedBy(err)) throw hardStopError()
            if (err instanceof HeadReadError) {
              headReadError ??= err
              break
            }
            if (!isTransportError(err)) {
              rpcErrors.push(err)
              break
            }
            lastTransportError = err
          }
        }
      }
      // every node failed; a halvable error lets fetchLogsAdaptive try a smaller range even when an earlier
      // node refused the method, and each sub-range reads a fresh head, starting from the first URL again
      if (rpcErrors.length > 0) throw rpcErrors.find(isHalvableError) ?? rpcErrors[0]
      throw lastTransportError ?? headReadError
    },
  }
}
