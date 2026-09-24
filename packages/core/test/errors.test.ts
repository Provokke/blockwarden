import { HttpRequestError, InvalidInputRpcError, RpcRequestError, TransactionRejectedRpcError } from 'viem'
import { describe, expect, it } from 'vitest'
import { describeError, rpcAnswer, short } from '../src/errors.js'

// How viem wraps a node's JSON-RPC error, which geth sends as -32000.
function rpcError(message: string, code = -32000) {
  const cause = new RpcRequestError({ body: {}, url: 'http://node', error: { code, message } })
  return code === -32000 ? new InvalidInputRpcError(cause) : new TransactionRejectedRpcError(cause)
}

describe('short', () => {
  it('leaves 256 characters alone and cuts one more to 256 ending in ...', () => {
    expect(short('a'.repeat(256))).toBe('a'.repeat(256))
    const cut = short('a'.repeat(257))
    expect(cut).toHaveLength(256)
    expect(cut.endsWith('...')).toBe(true)
  })
})

describe('rpcAnswer', () => {
  it("finds the node's answer however deep viem wrapped it, and nothing in an error no node sent", () => {
    expect(rpcAnswer(rpcError('nonce too low'))?.details).toBe('nonce too low')
    expect(rpcAnswer(new HttpRequestError({ url: 'http://node', status: 502 }))).toBeUndefined()
    expect(rpcAnswer(new Error('plain'))).toBeUndefined()
  })
})

describe('describeError', () => {
  it('shortens a node answer that repeats the raw transaction, so it fits on the item', () => {
    const raw = `0x${'ab'.repeat(8192)}`
    const message = describeError(rpcError(`invalid transaction: ${raw}`))
    expect(message.length).toBeLessThanOrEqual(256)
    expect(message).toMatch(/^invalid transaction: 0xabab/)
    expect(message.endsWith('...')).toBe(true)
    // the same cap on a long chain of causes, which are joined rather than read from the node's answer
    const chained = new Error('a'.repeat(400), { cause: new Error('b'.repeat(400)) })
    expect(describeError(chained).length).toBeLessThanOrEqual(256)
  })

  it('leaves a message that already fits alone', () => {
    expect(describeError(rpcError('replacement transaction underpriced'))).toBe('replacement transaction underpriced')
  })

  it('never includes the RPC URL, which can carry a provider API key', () => {
    const err = new HttpRequestError({ url: 'http://node.example/abcSECRETKEY', status: 502, details: 'nonce too low' })
    const message = describeError(err)
    expect(message).not.toContain('node.example')
    expect(message).not.toContain('abcSECRETKEY')
    expect(message).toContain('nonce too low')
  })

  it("falls back to viem's own words, still without the URL, when the node answered with no message", () => {
    // {"error":{"code":-32000}}: RpcRequestError.details is undefined, not the empty string
    const noMessage = new InvalidInputRpcError(
      new RpcRequestError({
        body: {},
        url: 'http://node.example/abcSECRETKEY',
        error: { code: -32000, message: undefined as unknown as string },
      }),
    )
    const message = describeError(noMessage)
    expect(message).not.toBe('')
    expect(message).not.toContain('abcSECRETKEY')
  })

  it('joins the message of each cause of an error viem did not make', () => {
    expect(describeError(new Error('outer', { cause: new Error('inner') }))).toBe('outer | inner')
  })
})
