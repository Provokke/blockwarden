import { BaseError, RpcRequestError } from 'viem'

// `@blockwarden/api` has no dependency on `services/relayer` (services/* depend on packages/*, not on each other),
// so this is a copied literal of services/relayer/src/chain.ts's describeError and short, not an import of them.
// A contract wallet's login makes an RPC call, and a viem error's full message and cause can carry the RPC URL with
// its API key; this keeps only the node's own words and viem's short messages.

const MAX_ERROR_CHARS = 256

function short(text: string): string {
  return text.length <= MAX_ERROR_CHARS ? text : `${text.slice(0, MAX_ERROR_CHARS - 3)}...`
}

function rpcAnswer(err: unknown): RpcRequestError | undefined {
  const found = err instanceof BaseError ? err.walk((e) => e instanceof RpcRequestError) : null
  return found instanceof RpcRequestError ? found : undefined
}

export function describeError(err: unknown): string {
  const answer = rpcAnswer(err)
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
