import { BaseError, RpcRequestError } from 'viem'

// The relayer stores and logs what a node said, and the API logs what a request ran into, a contract wallet's
// login included. A viem error's full message and cause can carry the RPC URL with its API key, so both describe an
// error through this one definition rather than two copies that could drift apart.

// The JSON-RPC error a node answered with, if it answered at all.
export function rpcAnswer(err: unknown): RpcRequestError | undefined {
  const found = err instanceof BaseError ? err.walk((e) => e instanceof RpcRequestError) : null
  return found instanceof RpcRequestError ? found : undefined
}

// A node's answer is stored on the transaction item and logged, and some echo the whole raw transaction back, so
// this is as much of one as either can afford. The 1 KB the reviewer measured put a full item at 392 KB.
const MAX_ERROR_CHARS = 256

export function short(text: string): string {
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
