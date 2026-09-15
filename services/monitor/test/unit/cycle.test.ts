import { DeadlineError } from '@blockwarden/core'
import {
  HttpRequestError,
  InternalRpcError,
  InvalidInputRpcError,
  InvalidParamsRpcError,
  InvalidRequestRpcError,
  LimitExceededRpcError,
  MethodNotFoundRpcError,
  MethodNotSupportedRpcError,
  ParseRpcError,
  ResponseBodyTooLargeError,
  TimeoutError,
  UnknownRpcError,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { isHalvableError, isJsonRpcError, LaggingNodeError } from '../../src/chain.js'
import {
  DROP_AFTER_BLOCKS,
  FAST_MAX_RANGE,
  FAST_OVERLAP,
  LEASE_MS,
  runCycle,
  type CycleDeps,
  type CycleResult,
} from '../../src/cycle.js'
import type { NewMatch, StoredRule } from '../../src/store.js'
import { CHAIN_ID, EMITTER, FakeChain, GENESIS_TIME, InMemoryStore, pingRule } from './fakes.js'

const NOW_MS = Date.parse('2026-09-15T12:00:00.000Z')

function deps(chain: FakeChain, store: InMemoryStore, extra: Partial<CycleDeps> = {}): CycleDeps {
  return {
    chainId: CHAIN_ID,
    chain,
    store,
    maxRange: 2000,
    timeBudgetMs: 50_000,
    startBlock: 0,
    now: () => NOW_MS,
    ...extra,
  }
}

const records = (store: InMemoryStore) =>
  [...store.matches.values()].map((m) => `${m.ruleId}:${m.args.value}@${m.blockNumber}:${m.status}`).sort()

function foreignMatch(blockNumber: number): NewMatch {
  return {
    matchKey: `0x${'ab'.repeat(32)}`,
    ruleId: 'fast',
    chainId: CHAIN_ID,
    blockNumber,
    blockHash: `0x${'cd'.repeat(32)}`,
    transactionHash: `0x${'ef'.repeat(32)}`,
    logIndex: 0,
    ordinal: 0,
    address: EMITTER,
    args: { value: 1n },
    firstSeenAt: '2026-09-15T00:00:00.000Z',
  }
}

const BUSY: CycleResult = {
  status: 'busy',
  head: 0,
  finalized: undefined,
  finalizedAgeSeconds: undefined,
  durableBlock: 0,
  fastBlock: 0,
  durableLag: undefined,
  final: 0,
  provisional: 0,
  dropped: 0,
  laggingNode: false,
  deadlineHit: false,
}

describe('runCycle', () => {
  it('records a fast log as provisional at the head and upgrades the same record to final once finalized', async () => {
    const chain = new FakeChain(10)
    const block = chain.emit(5n)
    const store = new InMemoryStore()
    store.rules.push(pingRule('fast', { mode: 'fast' }))

    expect(await runCycle(deps(chain, store))).toStrictEqual({
      status: 'ok',
      head: 11,
      finalized: 0,
      finalizedAgeSeconds: Math.floor(NOW_MS / 1000) - GENESIS_TIME,
      durableBlock: 0,
      fastBlock: 11,
      durableLag: 0,
      final: 0,
      provisional: 1,
      dropped: 0,
      laggingNode: false,
      deadlineHit: false,
    })
    const [provisional] = [...store.matches.values()]
    expect(provisional).toMatchObject({
      status: 'provisional',
      blockNumber: 11,
      blockHash: block.hash,
      transactionHash: block.txs[0]!.hash,
      logIndex: 0,
      ordinal: 0,
      firstSeenAt: new Date(NOW_MS).toISOString(),
    })

    chain.mine(64)
    expect(await runCycle(deps(chain, store, { now: () => NOW_MS + 60_000 }))).toMatchObject({
      status: 'ok',
      head: 75,
      finalized: 11,
      durableBlock: 11,
      fastBlock: 75,
      durableLag: 0,
      final: 1,
      provisional: 0,
    })
    expect(store.matches.size).toBe(1)
    expect(store.matches.get(provisional!.matchKey)).toMatchObject({
      status: 'final',
      blockNumber: 11,
      firstSeenAt: new Date(NOW_MS).toISOString(),
      finalizedAt: store.clock().toISOString(),
    })
    expect(store.finalWrites.map((w) => w.result)).toEqual(['upgraded'])
  })

  it('never writes a provisional record for a finalized-mode rule', async () => {
    const chain = new FakeChain(10)
    chain.emit(5n)
    chain.emit(500n)
    const store = new InMemoryStore()
    store.rules.push(pingRule('final', { mode: 'finalized' }), pingRule('fast', { mode: 'fast' }, 100n))
    const writeProvisional = vi.spyOn(store, 'writeProvisional')

    expect(await runCycle(deps(chain, store))).toMatchObject({ status: 'ok', provisional: 1, final: 0 })
    expect(records(store)).toEqual(['fast:500@12:provisional'])

    chain.mine(64)
    expect(await runCycle(deps(chain, store))).toMatchObject({ status: 'ok', provisional: 0, final: 3 })
    expect(records(store)).toEqual(['fast:500@12:final', 'final:500@12:final', 'final:5@11:final'])
    expect(writeProvisional.mock.calls.map(([m]) => m.ruleId)).toEqual(['fast'])
  })

  it('drops a provisional record reorged away once the durable scan is 64 blocks past its block', async () => {
    const chain = new FakeChain(10)
    chain.emit(5n)
    const store = new InMemoryStore()
    store.rules.push(pingRule('fast', { mode: 'fast' }))
    expect((await runCycle(deps(chain, store))).provisional).toBe(1)

    chain.reorg(1)
    chain.mine(127)
    expect(await runCycle(deps(chain, store))).toMatchObject({ durableBlock: 11 + DROP_AFTER_BLOCKS - 1, dropped: 0 })
    expect(records(store)).toEqual(['fast:5@11:provisional'])

    chain.mine(1)
    expect(await runCycle(deps(chain, store))).toMatchObject({
      status: 'ok',
      durableBlock: 11 + DROP_AFTER_BLOCKS,
      dropped: 1,
      final: 0,
    })
    expect(records(store)).toEqual(['fast:5@11:dropped'])
  })

  it('makes a dropped record final when its transaction is re-included later and finalized', async () => {
    const chain = new FakeChain(10)
    const tx = chain.emit(5n).txs[0]!.hash
    const store = new InMemoryStore()
    store.rules.push(pingRule('fast', { mode: 'fast' }))
    await runCycle(deps(chain, store))
    chain.reorg(1)
    chain.mine(128)
    expect((await runCycle(deps(chain, store, { now: () => NOW_MS + 1 }))).dropped).toBe(1)

    const again = chain.include({ hash: tx, values: [5n] })
    expect(await runCycle(deps(chain, store, { now: () => NOW_MS + 2 }))).toMatchObject({ provisional: 0, final: 0 })
    chain.mine(64)
    expect(await runCycle(deps(chain, store, { now: () => NOW_MS + 3 }))).toMatchObject({ status: 'ok', final: 1 })

    expect(store.matches.size).toBe(1)
    expect([...store.matches.values()][0]).toMatchObject({
      status: 'final',
      blockNumber: again.number,
      blockHash: again.hash,
      transactionHash: tx,
      ordinal: 0,
      firstSeenAt: new Date(NOW_MS).toISOString(),
    })
    expect(store.finalWrites.map((w) => w.result)).toEqual(['upgraded'])
  })

  it('uses the head minus finalityDepth as the finalized block when a depth is configured', async () => {
    const chain = new FakeChain(9)
    chain.emit(1n)
    chain.mine(4)
    chain.emit(2n)
    chain.emit(3n)
    chain.mine(4)
    const store = new InMemoryStore()
    store.rules.push(pingRule('final', { mode: 'finalized' }))

    expect(await runCycle(deps(chain, store, { finalityDepth: 5 }))).toStrictEqual({
      status: 'ok',
      head: 20,
      finalized: 15,
      finalizedAgeSeconds: undefined,
      durableBlock: 15,
      fastBlock: 0,
      durableLag: 0,
      final: 2,
      provisional: 0,
      dropped: 0,
      laggingNode: false,
      deadlineHit: false,
    })
    expect(records(store)).toEqual(['final:1@10:final', 'final:2@15:final'])

    expect(await runCycle(deps(new FakeChain(3), new InMemoryStore(), { finalityDepth: 10 }))).toMatchObject({
      finalized: 0,
      durableBlock: 0,
    })
  })

  it('makes no getFinalized call when finalityDepth is configured', async () => {
    const chain = new FakeChain(9)
    chain.emit(1n)
    const store = new InMemoryStore()
    store.rules.push(pingRule('final', { mode: 'finalized' }))

    expect(await runCycle(deps(chain, store, { finalityDepth: 5 }))).toMatchObject({ status: 'ok' })
    expect(chain.getFinalizedCalls).toBe(0)
  })

  it('still scans durably using head minus finalityDepth when getFinalized would throw a transport error', async () => {
    const chain = new FakeChain(9)
    chain.emit(1n)
    chain.finalizedFault = () => 'transport'
    const store = new InMemoryStore()
    store.rules.push(pingRule('final', { mode: 'finalized' }))

    expect(await runCycle(deps(chain, store, { finalityDepth: 5 }))).toMatchObject({
      status: 'ok',
      finalized: 5,
      durableBlock: 5,
    })
    expect(chain.getFinalizedCalls).toBe(0)
  })

  it('skips the durable scan and the drop but still runs the fast scan when finalized is unavailable', async () => {
    const chain = new FakeChain(200)
    chain.emit(7n)
    chain.finalizedFault = () => 'rpc-error'
    const store = new InMemoryStore()
    store.rules.push(pingRule('fast', { mode: 'fast' }), pingRule('final', { mode: 'finalized' }))
    store.cursors.set(CHAIN_ID, { durableBlock: 100, fastBlock: 190, version: 1 })
    await store.writeProvisional(foreignMatch(1))
    const drop = vi.spyOn(store, 'dropStaleProvisional')
    const getLogs = vi.spyOn(chain, 'getLogs')
    const log = vi.fn()

    expect(await runCycle(deps(chain, store, { log }))).toStrictEqual({
      status: 'ok',
      head: 201,
      finalized: undefined,
      finalizedAgeSeconds: undefined,
      durableBlock: 100,
      fastBlock: 201,
      durableLag: undefined,
      final: 0,
      provisional: 1,
      dropped: 0,
      laggingNode: false,
      deadlineHit: false,
    })
    expect(drop).not.toHaveBeenCalled()
    expect(getLogs.mock.calls.map(([, from, to]) => [from, to])).toEqual([[171, 201]])
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('finalized'),
      expect.objectContaining({ chainId: CHAIN_ID }),
    )
    expect(records(store)).toEqual(['fast:1@1:provisional', 'fast:7@201:provisional'])
  })

  it('propagates a transport error from getFinalized and releases the lease', async () => {
    const chain = new FakeChain(100)
    chain.emit(1n)
    chain.finalizedFault = () => 'transport'
    const store = new InMemoryStore()
    store.rules.push(pingRule('fast', { mode: 'fast' }))

    await expect(runCycle(deps(chain, store))).rejects.toBeInstanceOf(HttpRequestError)
    expect(store.leases.size).toBe(0)
    expect(store.cursors.size).toBe(0)
    expect(chain.getLogsCalls).toBe(0)
  })

  describe('lagging RPC node', () => {
    it('stops the durable scan at a range past the node head without saving it, and finishes it on a healthy node', async () => {
      const chain = new FakeChain(0)
      chain.emit(1n)
      chain.mine(16)
      // inside the second range, above the lagging head, so a clamped answer silently omits it
      chain.emit(2n)
      chain.mine(70)
      const store = new InMemoryStore()
      store.rules.push(pingRule('final', { mode: 'finalized' }), pingRule('fast', { mode: 'fast' }, 100n))
      chain.lagHead = () => 15
      const log = vi.fn()

      expect(await runCycle(deps(chain, store, { maxRange: 10, log }))).toMatchObject({
        status: 'ok',
        head: 88,
        finalized: 24,
        durableBlock: 10,
        durableLag: 14,
        fastBlock: 88,
        final: 1,
        laggingNode: true,
      })
      expect(store.cursors.get(CHAIN_ID)?.durableBlock).toBe(10)
      expect(records(store)).toEqual(['final:1@1:final'])
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('behind'),
        expect.objectContaining({ chainId: CHAIN_ID, head: 15, to: 20 }),
      )

      chain.lagHead = undefined
      expect(await runCycle(deps(chain, store, { maxRange: 10 }))).toMatchObject({
        status: 'ok',
        durableBlock: 24,
        final: 1,
        laggingNode: false,
      })
      expect(records(store)).toEqual(['final:1@1:final', 'final:2@18:final'])
    })

    it('rethrows a lagging node instead of halving the range', async () => {
      const err = new LaggingNodeError(3, 7)
      expect(isHalvableError(err)).toBe(false)
      expect(err.message).toContain('3')
      expect(err.message).toContain('7')

      const chain = new FakeChain(0)
      chain.emit(1n)
      chain.mine(70)
      chain.lagHead = () => 3
      const store = new InMemoryStore()
      store.rules.push(pingRule('final', { mode: 'finalized' }))
      const getLogsWithHead = vi.spyOn(chain, 'getLogsWithHead')

      expect(await runCycle(deps(chain, store))).toMatchObject({ durableBlock: 0, final: 0, laggingNode: true })
      expect(getLogsWithHead.mock.calls.map(([, from, to]) => [from, to])).toEqual([[1, 7]])
      expect(store.matches.size).toBe(0)
    })

    it('stops when the node head is one block short of a range that ends on a log', async () => {
      const chain = new FakeChain(9)
      chain.emit(1n)
      chain.mine(70)
      const store = new InMemoryStore()
      store.rules.push(pingRule('final', { mode: 'finalized' }))
      chain.lagHead = () => 9

      expect(await runCycle(deps(chain, store, { maxRange: 10 }))).toMatchObject({
        status: 'ok',
        durableBlock: 0,
        final: 0,
        laggingNode: true,
      })
      expect(store.cursors.get(CHAIN_ID)?.durableBlock).toBe(0)
      expect(store.withStatus('final')).toEqual([])
    })

    it('advances when the node head is exactly the end of a range that ends on a log', async () => {
      const chain = new FakeChain(9)
      chain.emit(1n)
      chain.mine(70)
      const store = new InMemoryStore()
      store.rules.push(pingRule('final', { mode: 'finalized' }))
      chain.lagHead = () => 10
      const getLogsWithHead = vi.spyOn(chain, 'getLogsWithHead')

      // the next range, 11..16, is past the lagging head, so the scan stops there
      expect(await runCycle(deps(chain, store, { maxRange: 10 }))).toMatchObject({
        status: 'ok',
        durableBlock: 10,
        final: 1,
        laggingNode: true,
      })
      expect(getLogsWithHead.mock.calls.map(([, from, to]) => [from, to])).toEqual([
        [1, 10],
        [11, 16],
      ])
      expect(store.cursors.get(CHAIN_ID)?.durableBlock).toBe(10)
      expect(records(store)).toEqual(['final:1@10:final'])
    })

    it('stops a halved range when the lag falls inside the right half', async () => {
      const chain = new FakeChain(1)
      chain.emit(1n)
      chain.mine(4)
      chain.emit(2n)
      chain.mine(70)
      const store = new InMemoryStore()
      store.rules.push(pingRule('final', { mode: 'finalized' }))
      chain.rangeLimit = 4
      chain.lagHead = () => 6
      const getLogsWithHead = vi.spyOn(chain, 'getLogsWithHead')

      // the left half was read in full below the lagging head, so it is kept
      expect(await runCycle(deps(chain, store, { maxRange: 8 }))).toMatchObject({
        status: 'ok',
        durableBlock: 4,
        final: 1,
        laggingNode: true,
      })
      expect(getLogsWithHead.mock.calls.map(([, from, to]) => [from, to])).toEqual([
        [1, 8],
        [1, 4],
        [5, 8],
      ])
      expect(store.cursors.get(CHAIN_ID)?.durableBlock).toBe(4)
      expect(records(store)).toEqual(['final:1@2:final'])
    })

    it('stops when the head read before the batch is behind the range end, even though the batched head is not', async () => {
      const chain = new FakeChain(9)
      chain.emit(1n)
      chain.mine(70)
      const store = new InMemoryStore()
      store.rules.push(pingRule('final', { mode: 'finalized' }))
      const read = chain.getLogsWithHead.bind(chain)
      // a node that runs batch entries concurrently answered the head after it caught up and the logs before
      vi.spyOn(chain, 'getLogsWithHead').mockImplementation(async (filter, from, to, options) => ({
        ...(await read(filter, from, to, options)),
        headBefore: to - 1,
      }))
      const log = vi.fn()

      expect(await runCycle(deps(chain, store, { maxRange: 10, log }))).toMatchObject({
        status: 'ok',
        durableBlock: 0,
        final: 0,
        laggingNode: true,
      })
      expect(store.cursors.get(CHAIN_ID)?.durableBlock).toBe(0)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('behind'), expect.objectContaining({ head: 9, to: 10 }))
    })
  })

  describe('halving', () => {
    const cause = new Error('from the node')

    it('halves on range-like JSON-RPC errors only, never on transport, lag, deadline or unsupported-method errors', () => {
      for (const err of [
        new MethodNotFoundRpcError(cause),
        new MethodNotSupportedRpcError(cause),
        new InvalidRequestRpcError(cause),
        new ParseRpcError(cause),
        new HttpRequestError({ url: 'http://rpc', status: 500 }),
        new TimeoutError({ body: {}, url: 'http://rpc' }),
        new LaggingNodeError(1, 2),
        new DeadlineError(),
      ]) {
        expect(isHalvableError(err), err.name).toBe(false)
      }
      for (const err of [
        new InvalidInputRpcError(cause),
        new InvalidParamsRpcError(cause),
        new InternalRpcError(cause),
        new LimitExceededRpcError(cause),
        new UnknownRpcError(cause),
        new Error('block range too large'),
      ]) {
        expect(isHalvableError(err), err.name).toBe(true)
      }
      expect(isJsonRpcError(new MethodNotFoundRpcError(cause))).toBe(true)
      expect(isJsonRpcError(new HttpRequestError({ url: 'http://rpc', status: 500 }))).toBe(false)
    })

    it('halves a durable range whose response body is too large', async () => {
      const chain = new FakeChain(0)
      chain.emit(1n)
      chain.mine(6)
      chain.emit(2n)
      chain.mine(70)
      const store = new InMemoryStore()
      store.rules.push(pingRule('final', { mode: 'finalized' }))
      const read = chain.getLogsWithHead.bind(chain)
      const getLogsWithHead = vi
        .spyOn(chain, 'getLogsWithHead')
        .mockImplementation(async (filter, from, to, options) => {
          if (to - from + 1 > 4) throw new ResponseBodyTooLargeError({ maxSize: 10_485_760, size: 10_485_761 })
          return read(filter, from, to, options)
        })

      expect(await runCycle(deps(chain, store, { maxRange: 8 }))).toMatchObject({
        status: 'ok',
        finalized: 14,
        durableBlock: 14,
        final: 2,
      })
      expect(getLogsWithHead.mock.calls.slice(0, 3).map(([, from, to]) => [from, to])).toEqual([
        [1, 8],
        [1, 4],
        [5, 8],
      ])
      expect(records(store)).toEqual(['final:1@1:final', 'final:2@8:final'])
    })

    it('rethrows method not found from the durable scan without halving the range', async () => {
      const chain = new FakeChain(100)
      const store = new InMemoryStore()
      store.rules.push(pingRule('final', { mode: 'finalized' }))
      const err = new MethodNotFoundRpcError(cause)
      const getLogsWithHead = vi.spyOn(chain, 'getLogsWithHead').mockRejectedValue(err)

      await expect(runCycle(deps(chain, store))).rejects.toBe(err)
      expect(getLogsWithHead).toHaveBeenCalledTimes(1)
      expect(store.cursors.get(CHAIN_ID)?.durableBlock).toBe(0)
    })

    it('rethrows method not found from the fast scan without halving the range', async () => {
      const chain = new FakeChain(100)
      chain.finalizedFault = () => 'rpc-error'
      const store = new InMemoryStore()
      store.rules.push(pingRule('fast', { mode: 'fast' }))
      const err = new MethodNotFoundRpcError(cause)
      const getLogs = vi.spyOn(chain, 'getLogs').mockRejectedValue(err)

      await expect(runCycle(deps(chain, store))).rejects.toBe(err)
      expect(getLogs).toHaveBeenCalledTimes(1)
    })
  })

  describe('start block', () => {
    const both = (): StoredRule[] => [pingRule('fast', { mode: 'fast' }), pingRule('final', { mode: 'finalized' })]

    it('never scans the start block or below with either scan', async () => {
      const chain = new FakeChain(9)
      chain.emit(1n)
      chain.emit(2n)
      const store = new InMemoryStore()
      store.rules.push(...both())

      expect(await runCycle(deps(chain, store, { startBlock: 10 }))).toMatchObject({ provisional: 1 })
      expect(store.cursors.get(CHAIN_ID)).toEqual({ durableBlock: 10, fastBlock: 11, version: 2 })
      chain.mine(64)
      expect(await runCycle(deps(chain, store, { startBlock: 10 }))).toMatchObject({ final: 2, durableBlock: 11 })
      expect(records(store)).toEqual(['fast:2@11:final', 'final:2@11:final'])
    })

    it('starts the durable scan after the finalized block and the fast scan at the head when unset', async () => {
      const chain = new FakeChain(29)
      chain.emit(1n)
      chain.mine(45)
      // above the finalized block but below the fast scan's overlap with the head
      chain.emit(2n)
      chain.mine(25)
      const store = new InMemoryStore()
      store.rules.push(...both())

      expect(await runCycle(deps(chain, store, { startBlock: undefined }))).toMatchObject({
        finalized: 37,
        durableBlock: 37,
        fastBlock: 101,
        final: 0,
        provisional: 0,
      })
      chain.emit(3n)
      chain.mine(200)
      await runCycle(deps(chain, store, { startBlock: undefined }))
      expect(records(store)).toEqual(['fast:2@76:final', 'fast:3@102:final', 'final:2@76:final', 'final:3@102:final'])
    })

    it('waits without a cursor or either scan when unset and finalized is unavailable, then starts at finalized', async () => {
      const chain = new FakeChain(100)
      chain.emit(1n)
      chain.finalizedFault = () => 'rpc-error'
      const store = new InMemoryStore()
      store.rules.push(...both())
      const log = vi.fn()

      expect(await runCycle(deps(chain, store, { startBlock: undefined, log }))).toMatchObject({
        status: 'ok',
        finalized: undefined,
        durableLag: undefined,
        final: 0,
        provisional: 0,
      })
      expect(store.cursors.size).toBe(0)
      expect(chain.getLogsCalls).toBe(0)
      expect(store.matches.size).toBe(0)
      expect(store.leases.size).toBe(0)
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('cursor'),
        expect.objectContaining({ chainId: CHAIN_ID }),
      )

      chain.finalizedFault = undefined
      chain.mine(70)
      expect(await runCycle(deps(chain, store, { startBlock: undefined }))).toMatchObject({
        status: 'ok',
        finalized: 107,
        durableBlock: 107,
        fastBlock: 171,
      })
    })

    it('keeps a start block above the head exclusive after the fast cursor follows the head down', async () => {
      const chain = new FakeChain(5)
      const store = new InMemoryStore()
      store.rules.push(...both())

      expect(await runCycle(deps(chain, store, { startBlock: 10 }))).toMatchObject({ durableBlock: 10, fastBlock: 5 })
      chain.mine(4)
      chain.emit(1n)
      chain.emit(2n)
      expect(await runCycle(deps(chain, store, { startBlock: 10 }))).toMatchObject({ provisional: 1, fastBlock: 11 })
      expect(records(store)).toEqual(['fast:2@11:provisional'])
    })
  })

  it('returns busy without any chain call while another owner holds the lease', async () => {
    const chain = new FakeChain(100)
    chain.emit(1n)
    const store = new InMemoryStore()
    store.rules.push(pingRule('fast', { mode: 'fast' }))
    expect(await store.acquireLease(CHAIN_ID, 'other', 1_000, LEASE_MS)).toBe(true)
    const calls = [vi.spyOn(chain, 'getHead'), vi.spyOn(chain, 'getFinalized'), vi.spyOn(chain, 'getLogs')]

    expect(await runCycle(deps(chain, store, { now: () => 2_000 }))).toStrictEqual(BUSY)
    for (const call of calls) expect(call).not.toHaveBeenCalled()
    expect(chain.readCalls).toBe(0)
    expect(store.cursors.size).toBe(0)
    expect(store.matches.size).toBe(0)

    expect((await runCycle(deps(chain, store, { now: () => 1_000 + LEASE_MS + 1 }))).status).toBe('ok')
  })

  it('takes the lease with its owner and duration and releases it after the cycle', async () => {
    const chain = new FakeChain(3)
    const store = new InMemoryStore()
    const acquire = vi.spyOn(store, 'acquireLease')
    const release = vi.spyOn(store, 'releaseLease')

    expect((await runCycle(deps(chain, store, { owner: 'me', leaseMs: 5_000, now: () => 7 }))).status).toBe('ok')
    expect(acquire).toHaveBeenCalledWith(CHAIN_ID, 'me', 7, 5_000)
    expect(release).toHaveBeenCalledWith(CHAIN_ID, 'me')
    expect(store.leases.size).toBe(0)

    await runCycle(deps(chain, store, { now: () => 9 }))
    const [, first] = acquire.mock.calls[0]!
    const [, second, , ms] = acquire.mock.calls.at(-1)!
    expect(second).not.toBe(first)
    expect(second).toMatch(/^[0-9a-f-]{36}$/)
    expect(ms).toBe(LEASE_MS)
    expect(LEASE_MS).toBe(90_000)
  })

  it('keeps the cycle error when releasing the lease also fails, and logs the release failure', async () => {
    const chain = new FakeChain(3)
    chain.emit(1n)
    const store = new InMemoryStore()
    store.rules.push(pingRule('fast', { mode: 'fast' }))
    vi.spyOn(store, 'writeProvisional').mockRejectedValueOnce(new Error('throttled'))
    vi.spyOn(store, 'releaseLease').mockRejectedValueOnce(new Error('release failed'))
    const log = vi.fn()

    await expect(runCycle(deps(chain, store, { log }))).rejects.toThrow('throttled')
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('lease'),
      expect.objectContaining({ chainId: CHAIN_ID, error: 'release failed' }),
    )
  })

  it('propagates a release failure after a successful cycle', async () => {
    const chain = new FakeChain(3)
    const store = new InMemoryStore()
    vi.spyOn(store, 'releaseLease').mockRejectedValueOnce(new Error('release failed'))

    await expect(runCycle(deps(chain, store))).rejects.toThrow('release failed')
  })

  it('returns conflict when another invocation creates the cursor first', async () => {
    const chain = new FakeChain(100)
    const store = new InMemoryStore()
    store.rules.push(pingRule('fast', { mode: 'fast' }))
    store.conflictOnNextSave = true

    expect(await runCycle(deps(chain, store, { startBlock: 7 }))).toStrictEqual({
      status: 'conflict',
      head: 100,
      finalized: 36,
      finalizedAgeSeconds: Math.floor(NOW_MS / 1000) - (GENESIS_TIME + 36 * 2),
      durableBlock: 7,
      fastBlock: 7,
      durableLag: 29,
      final: 0,
      provisional: 0,
      dropped: 0,
      laggingNode: false,
      deadlineHit: false,
    })
    expect(store.cursors.size).toBe(0)
    expect(chain.getLogsCalls).toBe(0)
    expect(store.leases.size).toBe(0)
  })

  it('returns conflict and stops scanning when another invocation saved the cursor during the durable scan', async () => {
    const chain = new FakeChain(0)
    chain.emit(1n)
    chain.emit(2n)
    chain.mine(70)
    const store = new InMemoryStore()
    store.rules.push(pingRule('fast', { mode: 'fast' }), pingRule('final', { mode: 'finalized' }))
    store.cursors.set(CHAIN_ID, { durableBlock: 0, fastBlock: 0, version: 4 })
    store.conflictOnNextSave = true

    expect(await runCycle(deps(chain, store, { maxRange: 1 }))).toMatchObject({
      status: 'conflict',
      durableBlock: 0,
      final: 2,
      provisional: 0,
      dropped: 0,
      laggingNode: false,
      deadlineHit: false,
    })
    expect(chain.getLogsCalls).toBe(1)
    expect(store.cursors.get(CHAIN_ID)).toEqual({ durableBlock: 0, fastBlock: 0, version: 4 })
    expect(store.leases.size).toBe(0)
  })

  it('leaves exactly one final record per event, each created once, after a crash in the middle of the durable scan', async () => {
    const chain = new FakeChain(0)
    chain.emit(1n)
    chain.emit(2n, 3n)
    chain.emit(4n)
    chain.mine(65)
    const store = new InMemoryStore()
    store.rules.push(pingRule('final', { mode: 'finalized' }))
    // saves: 1 creates the cursor, 2 moves it to block 1, 3 would move it to block 2
    store.crashOn('saveCursor', 3)

    await expect(runCycle(deps(chain, store, { maxRange: 1 }))).rejects.toThrow('simulated crash')
    expect(store.cursors.get(CHAIN_ID)?.durableBlock).toBe(1)
    expect(store.leases.size).toBe(0)
    expect(store.withStatus('final')).toHaveLength(3)

    expect(await runCycle(deps(chain, store, { maxRange: 1 }))).toMatchObject({
      status: 'ok',
      durableBlock: 4,
      final: 1,
    })
    expect(records(store)).toEqual(['final:1@1:final', 'final:2@2:final', 'final:3@2:final', 'final:4@3:final'])
    expect(
      [...store.matches.values()]
        .filter((m) => m.blockNumber === 2)
        .map((m) => m.ordinal)
        .sort(),
    ).toEqual([0, 1])
    const created = store.finalWrites.filter((w) => w.result === 'created').map((w) => w.matchKey)
    expect(created).toHaveLength(4)
    expect(new Set(created).size).toBe(4)
  })

  describe('fast scan range', () => {
    it('reads the fast range in chunks of at most maxRange blocks and saves the fast cursor once', async () => {
      const chain = new FakeChain(100)
      chain.emit(1n)
      chain.mine(24)
      chain.finalizedFault = () => 'rpc-error'
      const store = new InMemoryStore()
      store.rules.push(pingRule('fast', { mode: 'fast' }))
      store.cursors.set(CHAIN_ID, { durableBlock: 95, fastBlock: 95, version: 1 })
      const getLogs = vi.spyOn(chain, 'getLogs')

      expect(await runCycle(deps(chain, store, { maxRange: 10 }))).toMatchObject({
        status: 'ok',
        provisional: 1,
        fastBlock: 125,
      })
      expect(getLogs.mock.calls.map(([, from, to]) => [from, to])).toEqual([
        [96, 105],
        [106, 115],
        [116, 125],
      ])
      expect(store.cursors.get(CHAIN_ID)).toEqual({ durableBlock: 95, fastBlock: 125, version: 2 })
    })

    it('keeps the fast chunks read before the deadline', async () => {
      const chain = new FakeChain(100)
      chain.mine(25)
      chain.emit(1n)
      chain.finalizedFault = () => 'rpc-error'
      const store = new InMemoryStore()
      store.rules.push(pingRule('fast', { mode: 'fast' }))
      store.cursors.set(CHAIN_ID, { durableBlock: 95, fastBlock: 95, version: 1 })
      const now = () => (chain.getLogsCalls >= 2 ? NOW_MS + 60_000 : NOW_MS)

      expect(await runCycle(deps(chain, store, { maxRange: 10, now }))).toMatchObject({
        status: 'ok',
        provisional: 0,
        fastBlock: 115,
        deadlineHit: true,
      })
      expect(chain.getLogsCalls).toBe(2)
      expect(store.cursors.get(CHAIN_ID)).toEqual({ durableBlock: 95, fastBlock: 115, version: 2 })
    })

    it('never moves the fast cursor back when a narrow range keeps running out of time inside the overlap', async () => {
      const chain = new FakeChain(100)
      chain.finalizedFault = () => 'rpc-error'
      const store = new InMemoryStore()
      store.rules.push(pingRule('fast', { mode: 'fast' }))
      store.cursors.set(CHAIN_ID, { durableBlock: 0, fastBlock: 81, version: 1 })
      const fastBlocks: number[] = []

      for (let run = 0; run < 4; run++) {
        const callsAtStart = chain.getLogsCalls
        const now = () => (chain.getLogsCalls > callsAtStart ? NOW_MS + 60_000 : NOW_MS)
        expect(await runCycle(deps(chain, store, { maxRange: 1, now }))).toMatchObject({
          status: 'ok',
          deadlineHit: true,
        })
        expect(chain.getLogsCalls).toBe(callsAtStart + 1)
        fastBlocks.push(store.cursors.get(CHAIN_ID)!.fastBlock)
      }

      expect(fastBlocks).toEqual([81, 81, 81, 81])
    })

    it('skips ahead to the last 2000 blocks when further behind, then overlaps the previous head by 20', async () => {
      const chain = new FakeChain(99)
      chain.emit(1n)
      chain.mine(4399)
      chain.emit(2n)
      chain.mine(500)
      chain.finalizedFault = () => 'rpc-error'
      const store = new InMemoryStore()
      store.rules.push(pingRule('fast', { mode: 'fast' }))
      const getLogs = vi.spyOn(chain, 'getLogs')
      const ranges = () => getLogs.mock.calls.map(([, from, to]) => [from, to])

      expect(await runCycle(deps(chain, store))).toMatchObject({ provisional: 1, fastBlock: 5000, durableBlock: 0 })
      expect(ranges()).toEqual([[5000 - FAST_MAX_RANGE + 1, 5000]])
      expect(records(store)).toEqual(['fast:2@4500:provisional'])

      chain.mine(30)
      await runCycle(deps(chain, store))
      expect(ranges().at(-1)).toEqual([5000 - FAST_OVERLAP + 1, 5030])
    })

    it('never reaches back to or below the durable block', async () => {
      const chain = new FakeChain(5000)
      chain.finalizedFault = () => 'rpc-error'
      const store = new InMemoryStore()
      store.rules.push(pingRule('fast', { mode: 'fast' }))
      store.cursors.set(CHAIN_ID, { durableBlock: 4995, fastBlock: 5000, version: 1 })
      const getLogs = vi.spyOn(chain, 'getLogs')
      chain.mine(10)

      await runCycle(deps(chain, store))
      expect(getLogs.mock.calls.map(([, from, to]) => [from, to])).toEqual([[4996, 5010]])
    })

    it('moves the fast cursor back to a head that went backwards on a lagging backend', async () => {
      const chain = new FakeChain(100)
      chain.finalizedFault = () => 'rpc-error'
      chain.staleHeadBy = 30
      const store = new InMemoryStore()
      store.rules.push(pingRule('fast', { mode: 'fast' }))
      store.cursors.set(CHAIN_ID, { durableBlock: 0, fastBlock: 100, version: 1 })

      expect(await runCycle(deps(chain, store))).toMatchObject({ status: 'ok', head: 70, fastBlock: 70 })
      expect(store.cursors.get(CHAIN_ID)).toEqual({ durableBlock: 0, fastBlock: 70, version: 2 })
      expect(chain.getLogsCalls).toBe(0)
    })

    it('saves a head below the fast cursor before scanning, so a run stopped before its first chunk keeps it', async () => {
      const chain = new FakeChain(100)
      chain.finalizedFault = () => 'rpc-error'
      chain.staleHeadBy = 10
      const store = new InMemoryStore()
      store.rules.push(pingRule('fast', { mode: 'fast' }))
      store.cursors.set(CHAIN_ID, { durableBlock: 0, fastBlock: 100, version: 1 })
      const getLogs = vi.spyOn(chain, 'getLogs').mockRejectedValue(new DeadlineError())

      expect(await runCycle(deps(chain, store))).toMatchObject({
        status: 'ok',
        head: 90,
        fastBlock: 90,
        deadlineHit: true,
      })
      expect(getLogs.mock.calls.map(([, from, to]) => [from, to])).toEqual([[81, 90]])
      expect(store.cursors.get(CHAIN_ID)).toEqual({ durableBlock: 0, fastBlock: 90, version: 2 })
    })
  })

  it('makes no fast getLogs call when no rule is in fast mode', async () => {
    const chain = new FakeChain(100)
    const store = new InMemoryStore()
    store.rules.push(pingRule('final', { mode: 'finalized' }))
    const getLogs = vi.spyOn(chain, 'getLogs')

    expect(await runCycle(deps(chain, store))).toMatchObject({ status: 'ok', durableBlock: 36, fastBlock: 0 })
    expect(getLogs.mock.calls.map(([, from, to]) => [from, to])).toEqual([[1, 36]])
  })

  it('moves the durable cursor to finalized in one save, without reading logs, when there are no rules', async () => {
    const chain = new FakeChain(100)
    const store = new InMemoryStore()
    const save = vi.spyOn(store, 'saveCursor')

    expect(await runCycle(deps(chain, store, { maxRange: 10 }))).toMatchObject({ status: 'ok', durableBlock: 36 })
    expect(chain.getLogsCalls).toBe(0)
    expect(save.mock.calls.map(([, cursor]) => cursor.durableBlock)).toEqual([0, 36])
  })

  it('stops the durable scan and the fast scan when the time budget runs out, and reports the lag', async () => {
    const chain = new FakeChain(200)
    const store = new InMemoryStore()
    store.rules.push(pingRule('fast', { mode: 'fast' }), pingRule('final', { mode: 'finalized' }))
    const now = () => (chain.getLogsCalls >= 2 ? 60_000 : 0)

    expect(await runCycle(deps(chain, store, { maxRange: 10, now }))).toMatchObject({
      status: 'ok',
      finalized: 136,
      durableBlock: 20,
      durableLag: 116,
      fastBlock: 0,
      deadlineHit: true,
    })
    expect(chain.getLogsCalls).toBe(2)
  })

  it('splits durable ranges the RPC refuses', async () => {
    const chain = new FakeChain(0)
    chain.emit(11n)
    chain.mine(3)
    chain.emit(12n)
    chain.mine(70)
    chain.rangeLimit = 3
    const store = new InMemoryStore()
    store.rules.push(pingRule('final', { mode: 'finalized' }))

    expect(await runCycle(deps(chain, store))).toMatchObject({ status: 'ok', final: 2 })
  })

  describe('deadline', () => {
    it('commits each completed leaf when refused ranges eat the time, and the next run continues from it', async () => {
      const chain = new FakeChain(0)
      chain.emit(1n)
      chain.mine(28)
      chain.emit(2n)
      chain.mine(200)
      chain.rangeLimit = 4
      const store = new InMemoryStore()
      store.rules.push(pingRule('final', { mode: 'finalized' }))
      let clock = NOW_MS
      const read = chain.getLogs.bind(chain)
      // the primary refuses the range only after the dead backup has used up its timeout
      vi.spyOn(chain, 'getLogs').mockImplementation(async (filter, from, to) => {
        clock += to - from + 1 > chain.rangeLimit ? 6_000 : 1_000
        return read(filter, from, to)
      })
      const run = () => runCycle(deps(chain, store, { now: () => clock, deadlineMs: clock + 45_000 }))

      const first = await run()
      expect(first).toMatchObject({ status: 'ok', finalized: 166, deadlineHit: true })
      expect(first.durableBlock).toBeGreaterThan(0)
      expect(store.cursors.get(CHAIN_ID)?.durableBlock).toBe(first.durableBlock)
      expect(store.withStatus('final').every((m) => m.blockNumber <= first.durableBlock)).toBe(true)

      clock += LEASE_MS + 1
      const second = await run()
      expect(second).toMatchObject({ status: 'ok', deadlineHit: true })
      expect(second.durableBlock).toBeGreaterThan(first.durableBlock)
      expect(records(store)).toEqual(['final:1@1:final', ...(second.durableBlock >= 30 ? ['final:2@30:final'] : [])])
    })

    it('stops inside a halved range with the cursor at the end of the last completed leaf', async () => {
      const chain = new FakeChain(2)
      chain.emit(1n)
      chain.mine(3)
      chain.emit(2n)
      chain.mine(70)
      chain.rangeLimit = 4
      const store = new InMemoryStore()
      store.rules.push(pingRule('final', { mode: 'finalized' }))
      const getLogsWithHead = vi.spyOn(chain, 'getLogsWithHead')
      const now = () => (chain.getLogsCalls >= 2 ? NOW_MS + 60_000 : NOW_MS)

      expect(await runCycle(deps(chain, store, { maxRange: 8, now }))).toMatchObject({
        status: 'ok',
        durableBlock: 4,
        final: 1,
        laggingNode: false,
        deadlineHit: true,
      })
      expect(getLogsWithHead.mock.calls.map(([, from, to]) => [from, to])).toEqual([
        [1, 8],
        [1, 4],
      ])
      expect(store.cursors.get(CHAIN_ID)?.durableBlock).toBe(4)
      expect(records(store)).toEqual(['final:1@3:final'])
    })

    it('skips the drop and the fast scan once the deadline has passed', async () => {
      const chain = new FakeChain(300)
      const store = new InMemoryStore()
      store.rules.push(pingRule('fast', { mode: 'fast' }), pingRule('final', { mode: 'finalized' }))
      store.cursors.set(CHAIN_ID, { durableBlock: 200, fastBlock: 290, version: 1 })
      const drop = vi.spyOn(store, 'dropStaleProvisional')

      expect(await runCycle(deps(chain, store, { deadlineMs: NOW_MS - 1 }))).toMatchObject({
        status: 'ok',
        durableBlock: 200,
        fastBlock: 290,
        deadlineHit: true,
      })
      expect(drop).not.toHaveBeenCalled()
      expect(chain.getLogsCalls).toBe(0)
    })

    it.each(['getHead', 'getFinalized'] as const)(
      'returns ok without scanning and releases the lease when the hard stop passes during %s',
      async (method) => {
        const chain = new FakeChain(100)
        chain.emit(1n)
        const store = new InMemoryStore()
        store.rules.push(pingRule('fast', { mode: 'fast' }), pingRule('final', { mode: 'finalized' }))
        store.cursors.set(CHAIN_ID, { durableBlock: 10, fastBlock: 90, version: 1 })
        vi.spyOn(chain, method).mockRejectedValue(new DeadlineError())
        const log = vi.fn()

        expect(await runCycle(deps(chain, store, { log }))).toMatchObject({
          status: 'ok',
          finalized: undefined,
          durableLag: undefined,
          final: 0,
          provisional: 0,
          dropped: 0,
          laggingNode: false,
          deadlineHit: true,
        })
        expect(chain.getLogsCalls).toBe(0)
        expect(store.cursors.get(CHAIN_ID)).toEqual({ durableBlock: 10, fastBlock: 90, version: 1 })
        expect(store.leases.size).toBe(0)
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining('hard stop'),
          expect.objectContaining({ chainId: CHAIN_ID }),
        )
      },
    )

    it('keeps the ranges committed before a slow request runs into the hard stop', async () => {
      const chain = new FakeChain(0)
      chain.emit(1n)
      chain.mine(22)
      // inside the range the hard stop cuts off
      chain.emit(2n)
      chain.mine(80)
      const store = new InMemoryStore()
      store.rules.push(pingRule('fast', { mode: 'fast' }), pingRule('final', { mode: 'finalized' }))
      let clock = NOW_MS
      const hardStop = NOW_MS + 50_000
      const read = chain.getLogsWithHead.bind(chain)
      // each request takes 20 s; the reader aborts the one still running at the hard stop
      const getLogsWithHead = vi
        .spyOn(chain, 'getLogsWithHead')
        .mockImplementation(async (filter, from, to, options) => {
          if (clock + 20_000 > hardStop) {
            clock = hardStop
            throw new DeadlineError()
          }
          clock += 20_000
          return read(filter, from, to, options)
        })
      const drop = vi.spyOn(store, 'dropStaleProvisional')

      expect(
        await runCycle(deps(chain, store, { maxRange: 10, now: () => clock, deadlineMs: NOW_MS + 45_000 })),
      ).toMatchObject({ status: 'ok', finalized: 40, durableBlock: 20, final: 2, deadlineHit: true })
      expect(getLogsWithHead).toHaveBeenCalledTimes(3)
      expect(store.cursors.get(CHAIN_ID)?.durableBlock).toBe(20)
      expect(records(store)).toEqual(['fast:1@1:final', 'final:1@1:final'])
      expect(drop).not.toHaveBeenCalled()
      expect(chain.getLogsCalls).toBe(2)
    })

    it('starts the next range at the last leaf size that fitted, and doubles it after a range that needed no halving', async () => {
      const chain = new FakeChain(90)
      const store = new InMemoryStore()
      store.rules.push(pingRule('final', { mode: 'finalized' }))
      chain.rangeLimit = 4
      const getLogsWithHead = vi.spyOn(chain, 'getLogsWithHead')

      expect(await runCycle(deps(chain, store, { maxRange: 8 }))).toMatchObject({ status: 'ok', durableBlock: 26 })
      expect(getLogsWithHead.mock.calls.map(([, from, to]) => [from, to])).toEqual([
        [1, 8],
        [1, 4],
        [5, 8],
        [9, 12],
        [13, 20],
        [13, 16],
        [17, 20],
        [21, 24],
        [25, 26],
      ])
    })

    it('grows the range back to maxRange once the node accepts larger ranges again', async () => {
      const chain = new FakeChain(120)
      const store = new InMemoryStore()
      store.rules.push(pingRule('final', { mode: 'finalized' }))
      chain.rangeLimit = 4
      const read = chain.getLogsWithHead.bind(chain)
      let calls = 0
      const getLogsWithHead = vi
        .spyOn(chain, 'getLogsWithHead')
        .mockImplementation(async (filter, from, to, options) => {
          // the node stops refusing after the first four requests
          if (++calls > 4) chain.rangeLimit = Number.POSITIVE_INFINITY
          return read(filter, from, to, options)
        })

      expect(await runCycle(deps(chain, store, { maxRange: 16 }))).toMatchObject({ status: 'ok', durableBlock: 56 })
      expect(getLogsWithHead.mock.calls.map(([, from, to]) => [from, to])).toEqual([
        [1, 16],
        [1, 8],
        [1, 4],
        [5, 8],
        [9, 16],
        [17, 24],
        [25, 40],
        [41, 56],
      ])
    })

    it('keeps the size that fitted after a refusal as a ceiling, so a fixed range limit is refused at most once more', async () => {
      const chain = new FakeChain(124)
      const store = new InMemoryStore()
      store.rules.push(pingRule('final', { mode: 'finalized' }))
      chain.rangeLimit = 5
      const read = chain.getLogsWithHead.bind(chain)
      const calls: { from: number; refused: boolean }[] = []
      vi.spyOn(chain, 'getLogsWithHead').mockImplementation(async (filter, from, to, options) => {
        calls.push({ from, refused: to - from + 1 > chain.rangeLimit })
        return read(filter, from, to, options)
      })

      expect(await runCycle(deps(chain, store, { maxRange: 16 }))).toMatchObject({ status: 'ok', durableBlock: 60 })
      // the first range, 1..16, is the one that finds the limit by halving
      const later = calls.filter((c) => c.from > 16)
      expect(later.filter((c) => !c.refused).length).toBeGreaterThanOrEqual(10)
      expect(later.filter((c) => c.refused).length).toBeLessThanOrEqual(1)
    })
  })

  it('skips and logs a stored rule that no longer compiles', async () => {
    const chain = new FakeChain(0)
    chain.emit(1n)
    chain.mine(70)
    const store = new InMemoryStore()
    const broken = pingRule('broken', { mode: 'finalized' })
    store.rules.push({ ...broken, input: { ...broken.input, event: 'event Ping(uint256' } })
    store.rules.push(pingRule('final', { mode: 'finalized' }))
    const log = vi.fn()

    expect(await runCycle(deps(chain, store, { log }))).toMatchObject({ status: 'ok', final: 1 })
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ ruleId: 'broken' }))
    expect(records(store)).toEqual(['final:1@1:final'])
  })

  it('keeps one record per event when the provider returns the same log twice to both scans', async () => {
    const chain = new FakeChain(10)
    chain.emit(5n)
    const store = new InMemoryStore()
    store.rules.push(pingRule('fast', { mode: 'fast' }))
    const read = chain.getLogs.bind(chain)
    // the fake's batched read goes through getLogs, so the durable scan sees the duplicate too
    vi.spyOn(chain, 'getLogs').mockImplementation(async (filter, from, to) => {
      const logs = await read(filter, from, to)
      return [...logs, ...logs.map((l) => ({ ...l, topics: [...l.topics] }))]
    })

    expect(await runCycle(deps(chain, store))).toMatchObject({ provisional: 1 })
    chain.mine(64)
    expect(await runCycle(deps(chain, store))).toMatchObject({ final: 1 })
    expect(records(store)).toEqual(['fast:5@11:final'])
  })

  it('computes one match key for the same event in both scans', async () => {
    const chain = new FakeChain(0)
    chain.include({ values: [1n, 2n] }, { values: [3n] })
    const store = new InMemoryStore()
    store.rules.push(pingRule('fast', { mode: 'fast' }))

    expect((await runCycle(deps(chain, store))).provisional).toBe(3)
    chain.mine(64)
    expect(await runCycle(deps(chain, store))).toMatchObject({ final: 3 })
    expect(store.matches.size).toBe(3)
    expect(store.finalWrites.map((w) => w.result)).toEqual(['upgraded', 'upgraded', 'upgraded'])
    expect([...store.matches.values()].map((m) => [m.logIndex, m.ordinal])).toEqual([
      [0, 0],
      [1, 1],
      [2, 0],
    ])
  })
})
