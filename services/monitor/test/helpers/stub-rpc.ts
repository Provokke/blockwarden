import { createServer, type Server } from 'node:http'

// chain answers eth_blockNumber, eth_getLogs and the finalized block from StubRpcOptions, with STUB_HEAD and an
// empty log list by default; stalled-body sends the headers and the start of a body, then never finishes it
export type StubRpcMode = 'http-500' | 'rpc-error' | 'chain' | 'stalled-body'

export type JsonRpcErrorBody = { code: number; message: string }

export type StubRpcOptions = {
  // chain mode only
  head?: number
  // chain mode only: the head answered when eth_blockNumber is the only call in the request, as a pre-read is
  preReadHead?: number
  // chain mode only: answer a request whose only call is eth_blockNumber with this result or error instead
  preReadAnswer?: { result: unknown } | { error: JsonRpcErrorBody }
  // chain mode only: return these logs, or reject eth_getLogs with this JSON-RPC error
  logs?: unknown[] | JsonRpcErrorBody
  // chain mode only: answer eth_getBlockByNumber("finalized") with this block number instead of an error
  finalized?: number
  // answer the first N HTTP requests with HTTP 500, whatever the mode
  failFirst?: number
  // answer the first N HTTP requests that carry eth_getLogs with HTTP 500
  failFirstBatches?: number
  // chain mode only: answer a request that carries eth_getLogs with a body of this many bytes, sent as fast as
  // the client reads it, with or without a content-length header
  oversizedLogs?: { bytes: number; declareLength: boolean }
  // wait this long after a request arrives before answering it, whatever the mode
  delayMs?: number
}

export const MB = 1024 * 1024

export const STUB_HEAD = 42
export const LIMIT_EXCEEDED: JsonRpcErrorBody = { code: -32005, message: 'query returned more than 10000 results' }
export const METHOD_NOT_FOUND: JsonRpcErrorBody = { code: -32601, message: 'the method eth_getLogs does not exist' }

export type StubRpc = Awaited<ReturnType<typeof startStubRpc>>

type JsonRpcRequest = { id?: unknown; method?: unknown; params?: unknown[] }

const hex = (n: number) => `0x${n.toString(16)}`

export function startStubRpc(
  mode: StubRpcMode,
  options: StubRpcOptions = {},
): Promise<{
  url: string
  requestCount: () => number
  httpRequestCount: () => number
  bodies: () => unknown[]
  oversizedBytesSent: () => number[]
  close: () => Promise<void>
}> {
  let count = 0
  let httpCount = 0
  let logBatches = 0
  const seen: unknown[] = []
  const oversizedSent: number[] = []
  const head = options.head ?? STUB_HEAD

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () =>
      setTimeout(() => {
        if (res.destroyed) return
        let body: unknown
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch {
          body = {}
        }
        httpCount++
        seen.push(body)
        // viem may batch several JSON-RPC calls into one HTTP request; each
        // entry in that batch is still one RPC attempt, so count them all.
        const batch = (Array.isArray(body) ? body : [body]) as (JsonRpcRequest | null)[]
        count += batch.length
        const carriesLogs = batch.some((entry) => entry?.method === 'eth_getLogs')
        if (carriesLogs) logBatches++

        if (mode === 'stalled-body') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.write('{"jsonrpc":"2.0",')
          return
        }

        if (
          mode === 'http-500' ||
          httpCount <= (options.failFirst ?? 0) ||
          (carriesLogs && logBatches <= (options.failFirstBatches ?? 0))
        ) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'stub rpc: internal error' }))
          return
        }

        const oversized = options.oversizedLogs
        if (mode === 'chain' && carriesLogs && oversized) {
          const slot = oversizedSent.push(0) - 1
          res.writeHead(200, {
            'content-type': 'application/json',
            ...(oversized.declareLength ? { 'content-length': String(oversized.bytes) } : {}),
          })
          res.on('error', () => {})
          const chunk = Buffer.alloc(64 * 1024, 0x20)
          // counts only what the socket accepted, so a client that stops reading stops the count
          const pump = () => {
            while (!res.destroyed && oversizedSent[slot]! < oversized.bytes) {
              const n = Math.min(chunk.length, oversized.bytes - oversizedSent[slot]!)
              oversizedSent[slot]! += n
              if (!res.write(chunk.subarray(0, n))) {
                res.once('drain', pump)
                return
              }
            }
            if (!res.destroyed) res.end()
          }
          pump()
          return
        }

        const alone = batch.length === 1
        const answers = batch.map((entry) => {
          const { id = null, method, params } = entry ?? {}
          if (mode === 'chain' && method === 'eth_blockNumber') {
            if (alone && options.preReadAnswer) return { jsonrpc: '2.0', id, ...options.preReadAnswer }
            return { jsonrpc: '2.0', id, result: hex(alone ? (options.preReadHead ?? head) : head) }
          }
          if (mode === 'chain' && method === 'eth_getLogs') {
            const logs = options.logs ?? []
            return Array.isArray(logs) ? { jsonrpc: '2.0', id, result: logs } : { jsonrpc: '2.0', id, error: logs }
          }
          if (mode === 'chain' && method === 'eth_getBlockByNumber' && params?.[0] === 'finalized') {
            if (options.finalized !== undefined) {
              return { jsonrpc: '2.0', id, result: { number: hex(options.finalized), timestamp: hex(1_700_000_000) } }
            }
          }
          return { jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid block tag' } }
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(Array.isArray(body) ? answers : answers[0]))
      }, options.delayMs ?? 0),
    )
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('stub rpc server did not bind to a TCP port'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requestCount: () => count,
        httpRequestCount: () => httpCount,
        bodies: () => [...seen],
        oversizedBytesSent: () => [...oversizedSent],
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()))
            server.closeAllConnections()
          }),
      })
    })
  })
}
