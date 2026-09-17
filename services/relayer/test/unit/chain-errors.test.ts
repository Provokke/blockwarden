import {
  EstimateGasExecutionError,
  ExecutionRevertedError,
  HttpRequestError,
  InternalRpcError,
  InvalidInputRpcError,
  RpcRequestError,
  TimeoutError,
  TransactionRejectedRpcError,
} from 'viem'
import { describe, expect, it } from 'vitest'
import { classifyEstimateError, classifySendError } from '../../src/chain.js'

// How viem wraps a node's JSON-RPC error. The messages below were measured from Anvil 1.8.1 on 2026-09-17, or
// copied from go-ethereum's core/txpool/errors.go and core/error.go.
function rpcError(message: string, code = -32003) {
  const cause = new RpcRequestError({ body: {}, url: 'http://node', error: { code, message } })
  return code === -32000 ? new InvalidInputRpcError(cause) : new TransactionRejectedRpcError(cause)
}

describe('classifySendError', () => {
  it.each([
    ['transaction already imported', 'already-known'],
    ['already known', 'already-known'],
    ['nonce too low', 'nonce-too-low'],
    ['replacement transaction underpriced', 'underpriced'],
    ['transaction underpriced', 'underpriced'],
    ['max fee per gas less than block base fee', 'underpriced'],
    ['Insufficient funds for gas * price + value', 'insufficient-funds'],
    ['insufficient funds for gas * price + value: balance 0, tx cost 42000', 'insufficient-funds'],
    ['intrinsic gas too low', 'rejected'],
    ['intrinsic gas too high -- tx.gas_limit > env.block.gas_limit', 'rejected'],
    ['exceeds block gas limit', 'rejected'],
    ['invalid chain id for signer', 'rejected'],
    ['tx fee (1.10 ether) exceeds the configured cap (1.00 ether)', 'rejected'],
    ['max priority fee per gas higher than max fee per gas', 'rejected'],
    ['oversized data', 'rejected'],
    ['something new', 'unknown'],
  ] as const)('classifies "%s" as %s', (message, kind) => {
    expect(classifySendError(rpcError(message)).kind).toBe(kind)
  })

  it('reads the node message through an InvalidInputRpcError wrapper too', () => {
    expect(classifySendError(rpcError('intrinsic gas too low', -32000)).kind).toBe('rejected')
  })

  it('treats a transport failure as unknown, since the node may have taken the transaction', () => {
    const timeout = new TimeoutError({ body: {}, url: 'http://node' })
    const refused = new HttpRequestError({ url: 'http://node', status: 502, details: 'nonce too low' })
    expect(classifySendError(timeout).kind).toBe('unknown')
    // a proxy error page that happens to contain a node message is still a transport failure
    expect(classifySendError(refused).kind).toBe('unknown')
  })
})

describe('classifyEstimateError', () => {
  it('returns the revert data of an execution revert', () => {
    const data = '0x11fbe7120000000000000000000000000000000000000000000000000000000000000007'
    const cause = new RpcRequestError({
      body: {},
      url: 'http://node',
      error: { code: 3, message: 'execution reverted', data },
    })
    const err = new EstimateGasExecutionError(new ExecutionRevertedError({ cause, message: 'execution reverted' }), {})
    expect(classifyEstimateError(err)).toMatchObject({ kind: 'reverted', revertData: data })
  })

  it('returns 0x for a revert without data', () => {
    const err = new EstimateGasExecutionError(new ExecutionRevertedError({ message: 'execution reverted' }), {})
    expect(classifyEstimateError(err)).toMatchObject({ kind: 'reverted', revertData: '0x' })
  })

  it('separates an unreachable RPC from an estimate that failed for another reason', () => {
    const down = new EstimateGasExecutionError(new HttpRequestError({ url: 'http://node', status: 503 }), {})
    expect(classifyEstimateError(down).kind).toBe('unavailable')
    const other = new EstimateGasExecutionError(
      new InternalRpcError(
        new RpcRequestError({ body: {}, url: 'x', error: { code: -32603, message: 'gas required exceeds allowance' } }),
      ),
      {},
    )
    expect(classifyEstimateError(other).kind).toBe('failed')
    expect(classifyEstimateError(new Error('plain')).kind).toBe('failed')
  })
})
