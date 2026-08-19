import { DeadlineError } from '@blockwarden/core'
import { HttpRequestError, ResponseBodyTooLargeError, toEventSelector, type Hex } from 'viem'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createChainReader, isHalvableError, isJsonRpcError, type ChainReader } from '../../src/chain.js'
import { runCycle } from '../../src/cycle.js'
import { PING_EVENT, startAnvil, type Anvil } from '../helpers/anvil.js'
import {
  LIMIT_EXCEEDED,
  MB,
  METHOD_NOT_FOUND,
  startStubRpc,
  STUB_HEAD,
  type StubRpc,
  type StubRpcMode,
  type StubRpcOptions,
} from '../helpers/stub-rpc.js'
import { CHAIN_ID, InMemoryStore, pingRule } from '../unit/fakes.js'

describe('createChainReader against Anvil', () => {
  let anvil: Anvil
  let reader: ChainReader
  let emitter: Hex

  beforeAll(async () => {
    anvil = await startAnvil()
    reader = createChainReader([anvil.rpcUrl])
    emitter = await anvil.deployEmitter()
  })

  afterAll(async () => {
    await anvil?.stop()
  })

  it('reads a fresh head on every call', async () => {
    const before = await reader.getHead()
    await anvil.mine(3)
    expect(await reader.getHead()).toBe(before + 3)
  })

  it('returns logs with numeric positions and loses them after a reorg', async () => {
    const { blockNumber, blockHash } = await anvil.ping(emitter, 42n)
    const filter = { addresses: [emitter.toLowerCase() as Hex], topic0s: [toEventSelector(PING_EVENT)] }

    const logs = await reader.getLogs(filter, blockNumber, blockNumber)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ blockNumber, blockHash, logIndex: 0 })
    const head = await reader.getHead()
    expect(await reader.getLogsWithHead(filter, blockNumber, blockNumber)).toEqual({ logs, head, headBefore: head })

    await anvil.reorg(1)
    expect(await reader.getLogs(filter, blockNumber, blockNumber)).toHaveLength(0)
  })

  it('reports Anvil finalized as head minus 64', async () => {
    await anvil.mine(80)
    const head = await reader.getHead()
    const finalized = await reader.getFinalized()
    expect(finalized?.number).toBe(head - 64)
    expect(finalized?.timestamp).toBeGreaterThan(0)
  })

  it('fails over past a dead RPC URL', async () => {
    const withDeadFirst = createChainReader(['http://127.0.0.1:1', anvil.rpcUrl], 2_000)
    expect(await withDeadFirst.getHead()).toBe(await reader.getHead())
  })

  it('classifies transport failures as neither a JSON-RPC error nor a reason to halve', async () => {
    const dead = createChainReader(['http://127.0.0.1:1'], 1_000)
    const err = await dead.getHead().catch((e: unknown) => e)
    expect(isJsonRpcError(err)).toBe(false)
    expect(isHalvableError(err)).toBe(false)
    expect(isHalvableError(new Error('query returned more than 10000 results'))).toBe(true)
  })
})

describe('createChainReader against a stub RPC server', () => {
  let stubs: StubRpc[] = []

  afterEach(async () => {
    await Promise.all(stubs.map((server) => server.close()))
    stubs = []
  })

  async function stub(mode: StubRpcMode, options?: StubRpcOptions) {
    const server = await startStubRpc(mode, options)
    stubs.push(server)
    return server
  }

  const methodsOf = (body: unknown) =>
    (Array.isArray(body) ? body : [body]).map((call: { method: string }) => call.method).sort()
  const PAIR = ['eth_blockNumber', 'eth_getLogs']
  const HEAD = ['eth_blockNumber']
  const filter = { addresses: [`0x${'11'.repeat(20)}` as Hex], topic0s: [toEventSelector(PING_EVENT)] }
  const outcomeOf = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ resolved: value }),
      (err: unknown) => ({ rejected: err }),
    )

  function backupLog() {
    const blockHash = `0x${'aa'.repeat(32)}` as Hex
    const transactionHash = `0x${'bb'.repeat(32)}` as Hex
    const address = filter.addresses[0]!
    const topic = filter.topic0s[0]!
    return {
      raw: {
        address,
        topics: [topic],
        data: '0x',
        blockNumber: '0x2d',
        blockHash,
        transactionHash,
        transactionIndex: '0x0',
        logIndex: '0x3',
        removed: false,
      },
      mapped: { address, topics: [topic], data: '0x', blockNumber: 45, blockHash, transactionHash, logIndex: 3 },
    }
  }

  it('takes the backup head and logs together when the primary rejects the log request', async () => {
    const primary = await stub('chain', { head: 100, logs: LIMIT_EXCEEDED })
    const backup = await stub('chain', { head: 50, logs: [] })
    const reader = createChainReader([primary.url, backup.url])

    const outcome = await outcomeOf(reader.getLogsWithHead(filter, 80, 90))

    // never the primary head 100 with the backup's clamped logs
    expect(outcome).toEqual({ resolved: { head: 50, headBefore: 50, logs: [] } })
    expect(backup.bodies().map(methodsOf)).toEqual([HEAD, PAIR])
    // no retry sends the primary's log request apart from its head check
    expect(primary.bodies().map(methodsOf)).toEqual([HEAD, PAIR])
  })

  it('fails over to the backup when the primary rejects the log request with method not found', async () => {
    const log = backupLog()
    const primary = await stub('chain', { head: 100, logs: METHOD_NOT_FOUND })
    const backup = await stub('chain', { head: 50, logs: [log.raw] })
    const reader = createChainReader([primary.url, backup.url])

    expect(await reader.getLogsWithHead(filter, 40, 45)).toEqual({ head: 50, headBefore: 50, logs: [log.mapped] })
    expect(primary.bodies().map(methodsOf)).toEqual([HEAD, PAIR])
    expect(backup.bodies().map(methodsOf)).toEqual([HEAD, PAIR])
  })

  it('rejects with the range error after every node rejects it, so the range can be halved', async () => {
    const primary = await stub('chain', { head: 100, logs: LIMIT_EXCEEDED })
    const backup = await stub('chain', { head: 100, logs: LIMIT_EXCEEDED })
    const reader = createChainReader([primary.url, backup.url])

    const outcome = await outcomeOf(reader.getLogsWithHead(filter, 80, 90))

    expect(outcome).toHaveProperty('rejected')
    const err = (outcome as { rejected: unknown }).rejected
    expect(err).toMatchObject({ code: LIMIT_EXCEEDED.code })
    expect(isHalvableError(err)).toBe(true)
    expect(primary.bodies().map(methodsOf)).toEqual([HEAD, PAIR])
    expect(backup.bodies().map(methodsOf)).toEqual([HEAD, PAIR])
  })

  it.each([
    ['method not found, then limit exceeded', METHOD_NOT_FOUND, LIMIT_EXCEEDED, LIMIT_EXCEEDED.code],
    ['limit exceeded, then method not found', LIMIT_EXCEEDED, METHOD_NOT_FOUND, LIMIT_EXCEEDED.code],
    ['method not found on both', METHOD_NOT_FOUND, METHOD_NOT_FOUND, METHOD_NOT_FOUND.code],
  ])(
    'prefers a halvable error when every node rejects the log request: %s',
    async (_, primaryLogs, backupLogs, code) => {
      const primary = await stub('chain', { head: 100, logs: primaryLogs })
      const backup = await stub('chain', { head: 100, logs: backupLogs })
      const reader = createChainReader([primary.url, backup.url])

      const outcome = await outcomeOf(reader.getLogsWithHead(filter, 80, 90))

      expect(outcome).toHaveProperty('rejected')
      const err = (outcome as { rejected: unknown }).rejected
      expect(err).toMatchObject({ code })
      expect(isHalvableError(err)).toBe(code === LIMIT_EXCEEDED.code)
    },
  )

  it('rejects with the first JSON-RPC error when a later node fails at the transport level', async () => {
    const primary = await stub('chain', { head: 100, logs: LIMIT_EXCEEDED })
    const backup = await stub('http-500')
    const reader = createChainReader([primary.url, backup.url], 2_000)

    const outcome = await outcomeOf(reader.getLogsWithHead(filter, 80, 90))

    expect(outcome).toHaveProperty('rejected')
    const err = (outcome as { rejected: unknown }).rejected
    expect(err).toMatchObject({ code: LIMIT_EXCEEDED.code })
    expect(isHalvableError(err)).toBe(true)
    // the pre-read fails, so the pair is never sent to that node
    expect(backup.bodies().map(methodsOf)).toEqual([HEAD, HEAD])
  })

  it('rejects with the transport error from the last node when every node fails at the transport level', async () => {
    const primary = await stub('http-500')
    const backup = await stub('http-500')
    const reader = createChainReader([primary.url, backup.url], 2_000)

    const outcome = await outcomeOf(reader.getLogsWithHead(filter, 80, 90))

    expect(outcome).toHaveProperty('rejected')
    const err = (outcome as { rejected: unknown }).rejected
    expect(isJsonRpcError(err)).toBe(false)
    expect(err).toBeInstanceOf(HttpRequestError)
    // the reader keeps the full URL; only the handler redacts it
    expect((err as HttpRequestError).url).toBe(new URL(backup.url).href)
    expect(primary.bodies().map(methodsOf)).toEqual([HEAD, HEAD])
    expect(backup.bodies().map(methodsOf)).toEqual([HEAD, HEAD])
  })

  it.each([
    ['a JSON-RPC error', { error: { code: -32603, message: 'internal error' } }],
    ['a result that is not hex', { result: '0xnothex' }],
  ])('never halves a range when only the head pre-read fails, with %s', async (_, preReadAnswer) => {
    const primary = await stub('chain', { head: 100, preReadAnswer })
    const backup = await stub('chain', { head: 100, preReadAnswer })
    const reader = createChainReader([primary.url, backup.url], 2_000)

    const outcome = await outcomeOf(reader.getLogsWithHead(filter, 81, 90))

    expect(outcome).toHaveProperty('rejected')
    expect(isHalvableError((outcome as { rejected: unknown }).rejected)).toBe(false)
    expect(primary.bodies().map(methodsOf)).toEqual([HEAD])
    expect(backup.bodies().map(methodsOf)).toEqual([HEAD])

    // the head and finalized block come from elsewhere, so only the durable log reads reach the stubs
    const store = new InMemoryStore()
    store.rules.push(pingRule('final', { mode: 'finalized' }))
    const chain: ChainReader = {
      ...createChainReader([primary.url, backup.url], 2_000),
      getHead: async () => 100,
      getFinalized: async () => ({ number: 100, timestamp: 1_700_000_000 }),
    }
    await expect(
      runCycle({ chainId: CHAIN_ID, chain, store, maxRange: 10, timeBudgetMs: 50_000, startBlock: 80 }),
    ).rejects.toBeTruthy()
    expect(primary.bodies().map(methodsOf)).toEqual([HEAD, HEAD])
    expect(backup.bodies().map(methodsOf)).toEqual([HEAD, HEAD])
    expect(store.cursors.get(CHAIN_ID)?.durableBlock).toBe(80)
  })

  it.each([
    ['a JSON-RPC error', { error: { code: -32603, message: 'internal error' } }],
    ['a result that is not hex', { result: '0xnothex' }],
  ])('never halves a range when only the batched head fails, with %s', async (_, batchHeadAnswer) => {
    const primary = await stub('chain', { head: 100, batchHeadAnswer })
    const backup = await stub('chain', { head: 100, batchHeadAnswer })
    const reader = createChainReader([primary.url, backup.url], 2_000)

    const outcome = await outcomeOf(reader.getLogsWithHead(filter, 81, 90))

    expect(outcome).toHaveProperty('rejected')
    expect(isHalvableError((outcome as { rejected: unknown }).rejected)).toBe(false)
    // moves on to the next node after one pair, like a failed pre-read
    expect(primary.bodies().map(methodsOf)).toEqual([HEAD, PAIR])
    expect(backup.bodies().map(methodsOf)).toEqual([HEAD, PAIR])

    const store = new InMemoryStore()
    store.rules.push(pingRule('final', { mode: 'finalized' }))
    const chain: ChainReader = {
      ...createChainReader([primary.url, backup.url], 2_000),
      getHead: async () => 100,
      getFinalized: async () => ({ number: 100, timestamp: 1_700_000_000 }),
    }
    await expect(
      runCycle({ chainId: CHAIN_ID, chain, store, maxRange: 10, timeBudgetMs: 50_000, startBlock: 80 }),
    ).rejects.toBeTruthy()
    expect(primary.bodies().map(methodsOf)).toEqual([HEAD, PAIR, HEAD, PAIR])
    expect(backup.bodies().map(methodsOf)).toEqual([HEAD, PAIR, HEAD, PAIR])
    expect(store.cursors.get(CHAIN_ID)?.durableBlock).toBe(80)
  })

  it('re-sends the whole pair once on a transport failure and stays on that node when it succeeds', async () => {
    const primary = await stub('chain', { head: 60, failFirstBatches: 1 })
    const backup = await stub('chain', { head: 50 })
    const reader = createChainReader([primary.url, backup.url], 2_000)

    expect(await reader.getLogsWithHead(filter, 40, 45)).toEqual({ head: 60, headBefore: 60, logs: [] })
    // the pre-read head 60 already covers the range, so the retry sends only the pair
    expect(primary.bodies().map(methodsOf)).toEqual([HEAD, PAIR, PAIR])
    for (const body of primary.bodies().slice(1)) expect(Array.isArray(body)).toBe(true)
    expect(backup.httpRequestCount()).toBe(0)
  })

  it.each([
    ['an HTTP 500', async () => (await stub('http-500')).url],
    ['an unreachable URL', async () => 'http://127.0.0.1:1'],
  ])('fails over the head check and the log request together past %s', async (_, primaryUrl) => {
    const log = backupLog()
    const backup = await stub('chain', { head: 50, logs: [log.raw] })
    const reader = createChainReader([await primaryUrl(), backup.url], 2_000)

    expect(await reader.getLogsWithHead(filter, 40, 45)).toEqual({ head: 50, headBefore: 50, logs: [log.mapped] })
    expect(backup.bodies().map(methodsOf)).toEqual([HEAD, PAIR])
  })

  it('sends the head check first and the log request in one batched HTTP request, after a standalone pre-read', async () => {
    const server = await stub('chain')
    const reader = createChainReader([server.url])

    expect(await reader.getLogsWithHead(filter, 10, 20)).toEqual({ logs: [], head: STUB_HEAD, headBefore: STUB_HEAD })
    const bodies = server.bodies() as { method: string }[][]
    expect(bodies.map((body) => body.map((call) => call.method))).toEqual([HEAD, ['eth_blockNumber', 'eth_getLogs']])
  })

  it('pre-reads the head at most once per node while the head it last returned covers later ranges', async () => {
    const primary = await stub('chain', { head: 100, logs: LIMIT_EXCEEDED })
    const backup = await stub('chain', { head: 100 })
    const reader = createChainReader([primary.url, backup.url])

    await reader.getLogsWithHead(filter, 10, 20)
    await reader.getLogsWithHead(filter, 21, 60)
    await reader.getLogsWithHead(filter, 61, 100)
    expect(primary.bodies().map(methodsOf)).toEqual([HEAD, PAIR, PAIR, PAIR])
    expect(backup.bodies().map(methodsOf)).toEqual([HEAD, PAIR, PAIR, PAIR])

    await reader.getLogsWithHead(filter, 101, 110)
    expect(primary.bodies().map(methodsOf).slice(4)).toEqual([HEAD, PAIR])
    expect(backup.bodies().map(methodsOf).slice(4)).toEqual([HEAD, PAIR])
  })

  it('pre-reads the head again once the remembered heads are reset', async () => {
    const server = await stub('chain', { head: 100 })
    const reader = createChainReader([server.url])

    await reader.getLogsWithHead(filter, 10, 20)
    await reader.getLogsWithHead(filter, 21, 30)
    reader.resetRememberedHeads()
    await reader.getLogsWithHead(filter, 31, 40)

    expect(server.bodies().map(methodsOf)).toEqual([HEAD, PAIR, PAIR, HEAD, PAIR])
  })

  it('stops the durable scan when the batch head reaches the range end but the pre-read head does not', async () => {
    const to = 500
    // a node that runs batch entries concurrently can answer the head after it caught up and the logs before
    const server = await stub('chain', { head: to, preReadHead: to - 1, finalized: to, logs: [] })
    const reader = createChainReader([server.url])
    const store = new InMemoryStore()
    store.rules.push(pingRule('final', { mode: 'finalized' }))

    expect(await reader.getLogsWithHead(filter, to - 9, to)).toEqual({ logs: [], head: to, headBefore: to - 1 })

    const result = await runCycle({
      chainId: CHAIN_ID,
      chain: createChainReader([server.url]),
      store,
      maxRange: 2000,
      timeBudgetMs: 50_000,
      startBlock: to - 10,
    })
    expect(result).toMatchObject({ status: 'ok', finalized: to, durableBlock: to - 10, laggingNode: true })
    expect(store.cursors.get(CHAIN_ID)?.durableBlock).toBe(to - 10)
  })

  it('sends ordinary calls as single JSON-RPC requests, not one-element batches', async () => {
    const server = await stub('chain')
    const reader = createChainReader([server.url])

    expect(await reader.getHead()).toBe(STUB_HEAD)
    await reader.getFinalized()
    expect(server.bodies().map((body) => Array.isArray(body))).toEqual([false, false])
  })

  it('resolves getFinalized to undefined on a JSON-RPC error', async () => {
    const server = await stub('rpc-error')
    const reader = createChainReader([server.url])
    await expect(reader.getFinalized()).resolves.toBeUndefined()
  })

  it('rejects getFinalized on a transport failure instead of resolving undefined', async () => {
    const server = await stub('http-500')
    const reader = createChainReader([server.url])
    let resolved = false
    let caught: unknown
    try {
      await reader.getFinalized()
      resolved = true
    } catch (err) {
      caught = err
    }
    expect(resolved).toBe(false)
    expect(isJsonRpcError(caught)).toBe(false)
  })

  it('times out a response whose body stalls after the headers, on both clients', async () => {
    const server = await stub('stalled-body')
    const reader = createChainReader([server.url], 1_000)

    const started = Date.now()
    const outcomes = await Promise.all([outcomeOf(reader.getHead()), outcomeOf(reader.getLogsWithHead(filter, 1, 2))])

    expect(Date.now() - started).toBeLessThan(6_000)
    for (const outcome of outcomes) {
      expect(outcome).toHaveProperty('rejected')
      expect(isJsonRpcError((outcome as { rejected: unknown }).rejected)).toBe(false)
    }
  }, 20_000)

  it.each([
    ['without a content-length', false],
    ['with a content-length over the limit', true],
  ])(
    'rejects a log response body over 10 MB %s as a halvable error, without reading the rest of it',
    async (_, declareLength) => {
      const server = await stub('chain', { head: 100, oversizedLogs: { bytes: 64 * MB, declareLength } })
      const reader = createChainReader([server.url], 10_000)

      const outcomes = [
        await outcomeOf(reader.getLogsWithHead(filter, 1, 2)),
        await outcomeOf(reader.getLogs(filter, 1, 2)),
      ]

      for (const outcome of outcomes) {
        expect(outcome).toHaveProperty('rejected')
        const err = (outcome as { rejected: unknown }).rejected
        expect(err).toBeInstanceOf(ResponseBodyTooLargeError)
        expect(isHalvableError(err)).toBe(true)
      }
      const sent = server.oversizedBytesSent()
      expect(sent.length).toBeGreaterThanOrEqual(2)
      // the client stops reading at the limit; the rest is socket buffering, far short of the 64 MB body
      for (const bytes of sent) expect(bytes).toBeLessThan(32 * MB)
    },
    30_000,
  )

  it('downloads an oversized fast-scan log body once, without retrying it or walking on to the backup, so the scan halves at once', async () => {
    const oversizedLogs = { bytes: 64 * MB, declareLength: true }
    const primary = await stub('chain', { head: 100, oversizedLogs })
    const backup = await stub('chain', { head: 100, oversizedLogs })
    const urls = [primary.url, backup.url]

    const outcome = await outcomeOf(createChainReader(urls, 10_000).getLogs(filter, 1, 2))

    expect((outcome as { rejected: unknown }).rejected).toBeInstanceOf(ResponseBodyTooLargeError)
    expect(primary.oversizedBytesSent()).toHaveLength(1)
    expect(backup.httpRequestCount()).toBe(0)

    // finalized is unavailable, so only the fast scan reads: 99..100, then 99..99, which it cannot halve further
    const store = new InMemoryStore()
    store.rules.push(pingRule('fast', { mode: 'fast' }))
    await expect(
      runCycle({
        chainId: CHAIN_ID,
        chain: createChainReader(urls, 10_000),
        store,
        maxRange: 2000,
        timeBudgetMs: 50_000,
        startBlock: 98,
      }),
    ).rejects.toBeInstanceOf(ResponseBodyTooLargeError)
    expect(primary.oversizedBytesSent()).toHaveLength(3)
    // the backup still answers the finalized block the primary refuses, but never a log request
    expect(backup.oversizedBytesSent()).toHaveLength(0)
  }, 30_000)

  // viem backs off 150 ms before its first retry, or for as long as Retry-After asks
  it.each([
    [
      'an invalid-params error, without retrying it',
      'chain',
      { logs: { code: -32602, message: 'invalid params' } },
      1,
      0,
    ],
    ['a limit-exceeded error, retried after a backoff', 'chain', { logs: LIMIT_EXCEEDED }, 2, 150],
    ['an HTTP 500, retried after a backoff', 'http-500', {}, 2, 150],
    [
      'an HTTP 429, retried after its Retry-After',
      'http-500',
      { failWith: { status: 429, headers: { 'retry-after': '1' } } },
      2,
      1_000,
    ],
  ] as const)(
    'retries a fast-scan log read on each URL as viem does for %s',
    async (_, mode, options, attemptsPerUrl, backoffMs) => {
      const primary = await stub(mode, options)
      const backup = await stub(mode, options)
      const reader = createChainReader([primary.url, backup.url], 5_000)

      const started = Date.now()
      const outcome = await outcomeOf(reader.getLogs(filter, 1, 2))
      const elapsed = Date.now() - started

      expect(outcome).toHaveProperty('rejected')
      expect(primary.httpRequestCount()).toBe(attemptsPerUrl)
      expect(backup.httpRequestCount()).toBe(attemptsPerUrl)
      expect(elapsed).toBeGreaterThanOrEqual(2 * backoffMs)
    },
    20_000,
  )

  it('stops a fast-scan log read at the hard stop instead of backing off through every backup URL', async () => {
    const primary = await stub('chain', { head: 100, delayMs: 8_000 })
    const backups = await Promise.all(Array.from({ length: 6 }, () => stub('chain', { head: 100 })))
    const reader = createChainReader([primary.url, ...backups.map((backup) => backup.url)], 10_000)
    const started = Date.now()
    reader.setHardStop(started + 500)

    const outcome = await outcomeOf(reader.getLogs(filter, 1, 2))
    const elapsed = Date.now() - started

    expect((outcome as { rejected: unknown }).rejected).toBeInstanceOf(DeadlineError)
    // the primary's retry backs off 150 ms before it is refused; walking on would wait that long again for each
    // backup, which also refuses without sending anything, so six backups would add 900 ms
    expect(elapsed).toBeLessThan(1_100)
    for (const backup of backups) expect(backup.httpRequestCount()).toBe(0)
  }, 20_000)

  it('rejects every request still in flight at the hard stop, well before its timeout, without walking on to the backup', async () => {
    const primary = await stub('chain', { head: 100, finalized: 90, delayMs: 8_000 })
    const backup = await stub('chain', { head: 100, finalized: 90 })
    const reader = createChainReader([primary.url, backup.url], 10_000)
    const started = Date.now()
    reader.setHardStop(started + 1_000)

    const outcomes = await Promise.all([
      outcomeOf(reader.getHead()),
      outcomeOf(reader.getFinalized()),
      outcomeOf(reader.getLogs(filter, 1, 2)),
      outcomeOf(reader.getLogsWithHead(filter, 1, 2)),
    ])

    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(elapsed).toBeLessThan(4_000)
    for (const outcome of outcomes) {
      expect(outcome).toHaveProperty('rejected')
      expect((outcome as { rejected: unknown }).rejected).toBeInstanceOf(DeadlineError)
    }
    expect(backup.httpRequestCount()).toBe(0)
    // one request per call reached the node before the hard stop aborted it, and nothing was sent after it
    expect(primary.httpRequestCount()).toBe(4)
  }, 20_000)

  it('fails every request at once, without sending it, after the hard stop has passed, until it is cleared', async () => {
    const server = await stub('chain', { head: 100, finalized: 90 })
    const reader = createChainReader([server.url], 10_000)
    const started = Date.now()
    reader.setHardStop(started - 1)

    const outcomes = await Promise.all([
      outcomeOf(reader.getHead()),
      outcomeOf(reader.getFinalized()),
      outcomeOf(reader.getLogs(filter, 1, 2)),
      outcomeOf(reader.getLogsWithHead(filter, 1, 2)),
    ])

    expect(Date.now() - started).toBeLessThan(1_000)
    for (const outcome of outcomes) {
      expect((outcome as { rejected: unknown }).rejected).toBeInstanceOf(DeadlineError)
    }
    expect(server.httpRequestCount()).toBe(0)

    reader.setHardStop(undefined)
    expect(await reader.getHead()).toBe(100)
  })

  it('walks the fallback list once, retrying each URL once', async () => {
    const a = await stub('http-500')
    const b = await stub('http-500')
    const reader = createChainReader([a.url, b.url])

    await expect(reader.getHead()).rejects.toBeTruthy()

    // fallback's own retryCount: 0 means the URL list is walked exactly once;
    // each http() transport keeps its baked-in retryCount: 1, so each of the
    // 2 URLs is attempted twice. 2 URLs * 2 attempts = 4.
    expect(a.requestCount() + b.requestCount()).toBe(4)
  })
})
