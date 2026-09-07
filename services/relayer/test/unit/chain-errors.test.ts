import {
  EstimateGasExecutionError,
  ExecutionRevertedError,
  HttpRequestError,
  InvalidInputRpcError,
  RpcRequestError,
  TimeoutError,
  TransactionRejectedRpcError,
} from 'viem'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyEstimateError,
  classifySendError,
  createRelayerChain,
  describeError,
  EstimateError,
} from '../../src/chain.js'
import { chainOptionsFor } from '../../src/lambda/runtime.js'
import { deadUrl, startMockRpc, type MockReply, type MockRpc } from '../helpers/mock-rpc.js'

// How viem wraps a node's JSON-RPC error, which geth sends as -32000. Messages measured from Anvil 1.8.1, or copied
// from go-ethereum's core/txpool and core/error.go (master, 2026-09-17).
function rpcError(message: string, code = -32000) {
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
    ['transaction gas price below minimum: gas tip cap 1, minimum needed 1000000', 'underpriced'],
    ['Insufficient funds for gas * price + value', 'insufficient-funds'],
    ['insufficient funds for gas * price + value: balance 0, tx cost 42000', 'insufficient-funds'],
    ['intrinsic gas too low', 'rejected'],
    ['intrinsic gas too low: gas 20000, minimum needed 21000', 'rejected'],
    ['insufficient gas for floor data gas cost: gas 21000, minimum needed 21040', 'rejected'],
    ['transaction type not supported: tx type 3 not supported by this pool', 'rejected'],
    ['intrinsic gas too high -- tx.gas_limit > env.block.gas_limit', 'rejected'],
    ['exceeds block gas limit', 'rejected'],
    ['invalid chain id for signer', 'rejected'],
    ['tx fee (1.10 ether) exceeds the configured cap (1.00 ether)', 'rejected'],
    ['max priority fee per gas higher than max fee per gas', 'rejected'],
    ['oversized data', 'rejected'],
    // a gap closes once the earlier nonces land, and a filler at the gapped nonce would be refused the same way
    ['nonce too high: tx nonce 7, gapped nonce 5', 'unknown'],
    ['something new', 'unknown'],
  ] as const)('classifies "%s" as %s', (message, kind) => {
    expect(classifySendError(rpcError(message)).kind).toBe(kind)
  })

  it('reads the node message through a TransactionRejectedRpcError wrapper too', () => {
    expect(classifySendError(rpcError('intrinsic gas too low', -32003)).kind).toBe('rejected')
  })

  it('treats a transport failure as unknown, since the node may have taken the transaction', () => {
    const timeout = new TimeoutError({ body: {}, url: 'http://node' })
    const refused = new HttpRequestError({ url: 'http://node', status: 502, details: 'nonce too low' })
    expect(classifySendError(timeout).kind).toBe('unknown')
    // a proxy error page that happens to contain a node message is still a transport failure
    expect(classifySendError(refused).kind).toBe('unknown')
  })

  it('does not throw when the node answered with no message', () => {
    // {"error":{"code":-32000}}: RpcRequestError.details is undefined, not the empty string
    const noMessage = new InvalidInputRpcError(
      new RpcRequestError({
        body: {},
        url: 'http://node',
        error: { code: -32000, message: undefined as unknown as string },
      }),
    )
    expect(classifySendError(noMessage).kind).toBe('unknown')
    // {"error":"rate limited"}: viem reads "error" as a bare string, so .code and .message are both undefined
    const stringError = new RpcRequestError({
      body: {},
      url: 'http://node',
      error: 'rate limited' as unknown as { code: number; message: string },
    })
    expect(classifySendError(stringError).kind).toBe('unknown')
  })
})

describe('describeError', () => {
  it('never includes the RPC URL, which can carry a provider API key', () => {
    const err = new HttpRequestError({ url: 'http://node.example/abcSECRETKEY', status: 502, details: 'nonce too low' })
    const message = describeError(err)
    expect(message).not.toContain('node.example')
    expect(message).not.toContain('abcSECRETKEY')
    expect(message).not.toBe('')
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

  it('separates an unreachable RPC from an error that never reached a node', () => {
    const down = new EstimateGasExecutionError(new HttpRequestError({ url: 'http://node', status: 503 }), {})
    expect(classifyEstimateError(down).kind).toBe('unavailable')
    expect(classifyEstimateError(new Error('plain')).kind).toBe('failed')
  })

  it('does not throw when the node answered with no message', () => {
    const noMessage = new EstimateGasExecutionError(
      new InvalidInputRpcError(
        new RpcRequestError({
          body: {},
          url: 'http://node',
          error: { code: -32000, message: undefined as unknown as string },
        }),
      ),
      {},
    )
    expect(classifyEstimateError(noMessage)).toMatchObject({ kind: 'failed', message: expect.any(String) })
    expect(classifyEstimateError(noMessage).message).not.toBe('')
    const stringError = new EstimateGasExecutionError(
      new RpcRequestError({
        body: {},
        url: 'http://node',
        error: 'rate limited' as unknown as { code: number; message: string },
      }),
      {},
    )
    expect(classifyEstimateError(stringError)).toMatchObject({ kind: 'failed', message: expect.any(String) })
    expect(classifyEstimateError(stringError).message).not.toBe('')
  })
})

const FROM = '0x0000000000000000000000000000000000000001'
const TO = '0x0000000000000000000000000000000000000002'
// never decoded: the scripted nodes only look at the method
const RAW = '0x02f86c0180843b9aca00847735940082520894000000000000000000000000000000000000000180c0'

describe('createRelayerChain against scripted nodes', () => {
  const nodes: MockRpc[] = []
  const node = async (reply: (method: string) => MockReply) => {
    const started = await startMockRpc(reply)
    nodes.push(started)
    return started
  }
  const estimate = (urls: string[], timeoutMs?: number) =>
    createRelayerChain(1, urls, timeoutMs === undefined ? {} : { timeoutMs })
      .estimateGas({ from: FROM, to: TO, data: '0x', value: 0n })
      .catch((e: unknown) => e as EstimateError)

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((n) => n.stop()))
  })

  it('reports a revert with its data, and a revert without data as 0x', async () => {
    const data = '0x11fbe7120000000000000000000000000000000000000000000000000000000000000007'
    const withData = await node(() => ({ error: { code: 3, message: 'execution reverted', data } }))
    expect(await estimate([withData.url])).toMatchObject({ kind: 'reverted', revertData: data })
    const bare = await node(() => ({ error: { code: -32000, message: 'execution reverted' } }))
    expect(await estimate([bare.url])).toMatchObject({ kind: 'reverted', revertData: '0x' })
  })

  it('does not take running out of gas at the cap for a revert', async () => {
    // viem files this under ExecutionRevertedError, but geth sends it when the call needs more gas than the cap
    const capped = await node(() => ({ error: { code: -32000, message: 'gas required exceeds allowance (30000000)' } }))
    const err = await estimate([capped.url])
    expect(err).toBeInstanceOf(EstimateError)
    expect(err).toMatchObject({ kind: 'failed', message: 'gas required exceeds allowance (30000000)' })
    expect((err as EstimateError).revertData).toBeUndefined()
  })

  it('reports a rate limit on the estimate as unavailable', async () => {
    const plain = await node(() => ({ status: 429, text: 'Too Many Requests' }))
    expect(await estimate([plain.url])).toMatchObject({ kind: 'unavailable' })
    const limited = await node(() => ({ error: { code: -32005, message: 'rate limit exceeded' } }))
    expect(await estimate([limited.url])).toMatchObject({ kind: 'unavailable' })
    const both = await node(() => ({ status: 429, error: { code: -32005, message: 'rate limit exceeded' } }))
    expect(await estimate([both.url])).toMatchObject({ kind: 'unavailable' })
  })

  it("keeps the node's own words as the message, not the request body with the raw transaction", async () => {
    const message = 'insufficient funds for gas * price + value: balance 0, tx cost 42000, overshot 42000'
    const poor = await node(() => ({ error: { code: -32000, message } }))
    expect(await createRelayerChain(1, [poor.url]).send(RAW)).toEqual({ kind: 'insufficient-funds', message })
    const dead = await createRelayerChain(1, [await deadUrl()], { timeoutMs: 500 }).send(RAW)
    expect(dead.kind).toBe('unknown')
    expect((dead as { message: string }).message).not.toContain(RAW.slice(2))
  })

  describe('with a second RPC URL', () => {
    const refuse =
      (message: string) =>
      (method: string): MockReply =>
        method === 'eth_sendRawTransaction' || method === 'eth_estimateGas'
          ? { error: { code: -32000, message } }
          : { result: '0x1' }
    const accept = (method: string): MockReply => ({
      result: method === 'eth_sendRawTransaction' ? `0x${'ab'.repeat(32)}` : '0x5208',
    })

    it('keeps a definitive refusal instead of trying a dead URL', async () => {
      const first = await node(refuse('insufficient funds for gas * price + value: balance 0, tx cost 42000'))
      expect((await createRelayerChain(1, [first.url, await deadUrl()], { timeoutMs: 500 }).send(RAW)).kind).toBe(
        'insufficient-funds',
      )
    })

    it('keeps a definitive refusal instead of waiting on a hanging URL', async () => {
      const first = await node(refuse('replacement transaction underpriced'))
      const hanging = await node(() => 'hang')
      expect((await createRelayerChain(1, [first.url, hanging.url], { timeoutMs: 300 }).send(RAW)).kind).toBe(
        'underpriced',
      )
      expect(hanging.calls).toEqual([])
    })

    it('keeps a definitive refusal even when the next node would accept', async () => {
      const first = await node(refuse('nonce too low: next nonce 5, tx nonce 4'))
      const second = await node(accept)
      expect((await createRelayerChain(1, [first.url, second.url]).send(RAW)).kind).toBe('nonce-too-low')
      const poor = await node(refuse('insufficient funds for transfer'))
      expect(await estimate([poor.url, second.url])).toMatchObject({ kind: 'failed' })
      expect(second.calls).toEqual([])
    })

    it('moves on after a transport failure or a rate limit', async () => {
      const second = await node(accept)
      expect(await createRelayerChain(1, [await deadUrl(), second.url], { timeoutMs: 500 }).send(RAW)).toEqual({
        kind: 'accepted',
      })
      const limited = await node(() => ({ status: 429, text: 'Too Many Requests' }))
      expect(await createRelayerChain(1, [limited.url, second.url]).send(RAW)).toEqual({ kind: 'accepted' })
      const limitedRpc = await node(() => ({ error: { code: -32005, message: 'rate limit exceeded' } }))
      expect(await estimate([limitedRpc.url, second.url])).toBe(21_000n)
    })

    it('fails over from a URL that never answers within about 5 seconds with the API settings', async () => {
      const hanging = await node(() => 'hang')
      const second = await node(accept)
      const urls = [hanging.url, second.url]
      const started = Date.now()
      const gas = await createRelayerChain(1, urls, chainOptionsFor('api', urls.length)).estimateGas({
        from: FROM,
        to: TO,
        data: '0x',
        value: 0n,
      })
      expect(gas).toBe(21_000n)
      expect(Date.now() - started).toBeLessThan(5_500)
      expect(hanging.calls).toEqual(['eth_estimateGas'])
    }, 30_000)

    it('moves on when a node cannot serve the call, not just when it is unreachable', async () => {
      // an HTTP 500 with a JSON-RPC error body still answers through viem's normal error path, same as a 200 would
      const brokenNode =
        (message: string, code: number) =>
        (method: string): MockReply =>
          method === 'eth_sendRawTransaction' || method === 'eth_estimateGas'
            ? { error: { code, message }, status: 500 }
            : { result: '0x1' }
      const internalError = await node(brokenNode('Internal error', -32603))
      const second = await node(accept)
      expect(await createRelayerChain(1, [internalError.url, second.url]).send(RAW)).toEqual({ kind: 'accepted' })

      const methodNotSupported = await node(() => ({ error: { code: -32601, message: 'Method not found' } }))
      const third = await node(accept)
      expect(await estimate([methodNotSupported.url, third.url])).toBe(21_000n)
    })
  })

  describe('findReceipt', () => {
    const HASH = `0x${'cd'.repeat(32)}` as const
    const answering =
      (receipt: unknown) =>
      (method: string): MockReply =>
        method === 'eth_getTransactionReceipt' ? { result: receipt } : { result: '0x1' }
    const mined = {
      transactionHash: HASH,
      blockHash: `0x${'0f'.repeat(32)}`,
      blockNumber: '0x64',
      status: '0x1',
      transactionIndex: '0x0',
      from: FROM,
      to: TO,
      cumulativeGasUsed: '0x5208',
      gasUsed: '0x5208',
      effectiveGasPrice: '0x1',
      logs: [],
      logsBloom: `0x${'00'.repeat(256)}`,
      type: '0x2',
      contractAddress: null,
    }

    it('returns the receipt a later URL has when the first answers null', async () => {
      const lagging = await node(answering(null))
      const synced = await node(answering(mined))
      const chain = createRelayerChain(1, [lagging.url, synced.url])
      expect(await chain.getReceipt(HASH)).toBeUndefined()
      expect(await chain.findReceipt(HASH)).toEqual({
        hash: HASH,
        blockNumber: 100,
        blockHash: mined.blockHash,
        status: 'success',
      })
    })

    it('returns undefined only when every URL answered null', async () => {
      const first = await node(answering(null))
      const second = await node(answering(null))
      expect(await createRelayerChain(1, [first.url, second.url]).findReceipt(HASH)).toBeUndefined()
    })

    it('throws when a URL errored and none had the receipt, but not when another had it', async () => {
      const empty = await node(answering(null))
      const dead = await deadUrl()
      await expect(createRelayerChain(1, [empty.url, dead], { timeoutMs: 500 }).findReceipt(HASH)).rejects.toThrow()
      const synced = await node(answering(mined))
      expect(await createRelayerChain(1, [dead, synced.url], { timeoutMs: 500 }).findReceipt(HASH)).toMatchObject({
        hash: HASH,
      })
    })
  })

  describe('when the RPC body carries no message', () => {
    // HTTP 200 with a JSON-RPC error object missing "message", or with "error" as a bare string: both give an
    // RpcRequestError whose .details is undefined
    const noMessage = (): MockReply => ({ status: 200, text: '{"jsonrpc":"2.0","id":1,"error":{"code":-32000}}' })
    const stringError = (): MockReply => ({ status: 200, text: '{"jsonrpc":"2.0","id":1,"error":"rate limited"}' })

    it('send returns a result instead of throwing', async () => {
      const noMsg = await node(noMessage)
      expect(await createRelayerChain(1, [noMsg.url]).send(RAW)).toMatchObject({ kind: 'unknown' })
      const strErr = await node(stringError)
      expect(await createRelayerChain(1, [strErr.url]).send(RAW)).toMatchObject({ kind: 'unknown' })
    })

    it('estimate returns a result instead of throwing', async () => {
      const noMsg = await node(noMessage)
      expect(await estimate([noMsg.url])).toBeInstanceOf(EstimateError)
      const strErr = await node(stringError)
      expect(await estimate([strErr.url])).toBeInstanceOf(EstimateError)
    })
  })
})
