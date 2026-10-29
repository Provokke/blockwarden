import { BaseError, RpcRequestError } from 'viem'

// The relayer stores and logs what a node said, and the API logs what a request hit. A viem error's
// message and cause can carry the RPC URL with its API key, so both describe errors through this
// one definition.

// The JSON-RPC error a node answered with, if it answered at all.
export function rpcAnswer(err: unknown): RpcRequestError | undefined {
  const found = err instanceof BaseError ? err.walk((e) => e instanceof RpcRequestError) : null
  return found instanceof RpcRequestError ? found : undefined
}

// A node's answer is stored on the tx item and logged, and some echo the whole raw transaction, so
// keep as much as each can afford: an item holds several of these strings and DynamoDB caps the
// total size.
const MAX_ERROR_CHARS = 256

export function short(text: string): string {
  return text.length <= MAX_ERROR_CHARS ? text : `${text.slice(0, MAX_ERROR_CHARS - 3)}...`
}

// The node's own words, else viem's short messages. Never the full message: it repeats the raw tx
// and can carry the RPC URL with its API key.
export function describeError(err: unknown): string {
  const answer = rpcAnswer(err)
  // a node can answer with no "message", or "error" as a bare string; details is then undefined and
  // viem's shortMessage is the fallback
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
