import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { CycleDeps, CycleResult } from '../../src/cycle.js'

const SECRET = 'pathSecret123'
const RPC_URL = `https://base-mainnet.g.example.com/v2/${SECRET}`

vi.mock('../../src/config.js', () => ({
  loadConfig: async () => ({
    tableName: 'blockwarden',
    chainId: 8453,
    rpcUrls: [RPC_URL],
    maxRange: 2000,
    timeBudgetMs: 50_000,
  }),
}))
vi.mock('../../src/cycle.js', () => ({ runCycle: vi.fn() }))
// the runtime is built once per module, so only the first handler call in this file creates the reader
const readerCalls = vi.hoisted(() => [] as unknown[][])
const hardStops = vi.hoisted(() => [] as (number | undefined)[])
const headResets = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../src/chain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/chain.js')>()
  return {
    ...actual,
    createChainReader: (...args: Parameters<typeof actual.createChainReader>) => {
      readerCalls.push(args)
      const reader = actual.createChainReader(...args)
      return {
        ...reader,
        setHardStop: (epochMs: number | undefined) => {
          hardStops.push(epochMs)
          reader.setHardStop(epochMs)
        },
        resetRememberedHeads: () => {
          headResets.count++
          reader.resetRememberedHeads()
        },
      }
    },
  }
})

const { runCycle } = await import('../../src/cycle.js')
const { handler, requestTimeoutMs } = await import('../../src/handler.js')

function metricLines(output: string[]) {
  return output
    .join('\n')
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => '_aws' in line)
}

function metricNames(line: Record<string, unknown>) {
  return (line._aws as { CloudWatchMetrics: { Metrics: { Name: string }[] }[] }).CloudWatchMetrics.flatMap((group) =>
    group.Metrics.map((metric) => metric.Name),
  )
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
  ruleSkips: 0,
  ruleWarnings: 0,
}

describe('handler', () => {
  let output: string[]
  let spies: MockInstance[]

  beforeEach(() => {
    output = []
    const capture = (chunk: unknown) => {
      output.push(String(chunk))
      return true
    }
    spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(capture),
      vi.spyOn(process.stderr, 'write').mockImplementation(capture),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void capture(args.join(' '))),
      ),
    ]
  })

  afterEach(() => {
    for (const spy of spies) spy.mockRestore()
    vi.mocked(runCycle).mockReset()
  })

  it('never logs or rethrows a configured RPC URL from a failed cycle', async () => {
    vi.mocked(runCycle).mockImplementation(async (deps: CycleDeps) => {
      deps.log?.('RPC node is behind the durable range', {
        chainId: 8453,
        error: `from ${RPC_URL}`,
        nested: { urls: [RPC_URL], cause: new Error(`fetch failed for ${RPC_URL}`) },
      })
      const cause = new Error(`fetch failed for ${RPC_URL}/`)
      throw new Error(`HTTP request failed.\n\nURL: ${RPC_URL}`, { cause })
    })

    const thrown = await handler(undefined).then(
      () => undefined,
      (err: unknown) => err as Error,
    )

    expect(thrown).toBeInstanceOf(Error)
    expect(thrown?.cause).toBeUndefined()
    expect(thrown?.message).toContain('URL: rpc[0]')
    expect(`${thrown?.message}\n${thrown?.stack}`).not.toContain(SECRET)
    const logged = output.join('\n')
    expect(logged).toContain('rpc[0]')
    expect(logged).not.toContain(SECRET)
  })

  it('sets the cycle deadline 8 seconds before Lambda would stop the invocation, or at the time budget without a context', async () => {
    const deadlines: (number | undefined)[] = []
    vi.mocked(runCycle).mockImplementation(async (deps: CycleDeps) => {
      deadlines.push(deps.deadlineMs)
      return BUSY
    })
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 })
    try {
      await handler(undefined, { getRemainingTimeInMillis: () => 30_000 })
      await handler(undefined)
    } finally {
      vi.useRealTimers()
    }
    expect(deadlines).toEqual([1_000_000 + 30_000 - 8_000, 1_000_000 + 50_000])
  })

  it('sets the reader hard stop before the cycle, 3 seconds before Lambda would stop the invocation, or 5 seconds past the time budget without a context', async () => {
    const setBeforeCycle: number[] = []
    vi.mocked(runCycle).mockImplementation(async () => {
      setBeforeCycle.push(hardStops.length)
      return BUSY
    })
    hardStops.length = 0
    vi.useFakeTimers({ toFake: ['Date'], now: 2_000_000 })
    try {
      await handler(undefined, { getRemainingTimeInMillis: () => 30_000 })
      await handler(undefined)
    } finally {
      vi.useRealTimers()
    }
    expect(hardStops).toEqual([2_000_000 + 30_000 - 3_000, 2_000_000 + 50_000 + 5_000])
    expect(setBeforeCycle).toEqual([1, 2])
  })

  it('forgets the node heads remembered by earlier invocations before each cycle', async () => {
    const resetsBeforeCycle: number[] = []
    vi.mocked(runCycle).mockImplementation(async () => {
      resetsBeforeCycle.push(headResets.count)
      return BUSY
    })
    headResets.count = 0

    await handler(undefined)
    await handler(undefined)

    expect(resetsBeforeCycle).toEqual([1, 2])
  })

  it('creates the chain reader with a per-call timeout that fits two attempts per URL in the time budget', async () => {
    vi.mocked(runCycle).mockResolvedValue(BUSY)
    await handler(undefined)
    expect(readerCalls).toEqual([[[RPC_URL], 10_000]])
  })

  it('publishes only lag, age and skip metrics, and keeps the match counts in the cycle log', async () => {
    vi.mocked(runCycle).mockResolvedValue({
      ...BUSY,
      status: 'ok',
      head: 100,
      finalized: 36,
      finalizedAgeSeconds: 12,
      durableBlock: 30,
      fastBlock: 100,
      durableLag: 6,
      final: 2,
      provisional: 3,
      dropped: 1,
      laggingNode: true,
      deadlineHit: true,
    })

    await handler(undefined)

    const lines = output
      .join('\n')
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const emf = lines.filter((line) => '_aws' in line)
    expect(emf).toHaveLength(1)
    const published = (
      emf[0]!._aws as { CloudWatchMetrics: { Metrics: { Name: string }[] }[] }
    ).CloudWatchMetrics.flatMap((group) => group.Metrics.map((metric) => metric.Name))
    expect(published.sort()).toEqual(['deadlineSkips', 'durableLag', 'finalizedAgeSeconds', 'laggingNodeSkips'])
    expect(lines.find((line) => line.message === 'cycle finished')).toMatchObject({
      final: 2,
      provisional: 3,
      dropped: 1,
    })
  })

  it.each([
    ['laggingNode', 'laggingNodeSkips', 'deadlineSkips'],
    ['deadlineHit', 'deadlineSkips', 'laggingNodeSkips'],
  ] as const)(
    'publishes %s as %s with a count of 1, and neither skip metric when no flag is set',
    async (flag, metric, other) => {
      const observed = { ...BUSY, status: 'ok' as const, head: 100, finalized: 36, durableBlock: 30, durableLag: 6 }
      vi.mocked(runCycle).mockResolvedValueOnce({ ...observed, [flag]: true })

      await handler(undefined)

      const [flagged] = metricLines(output)
      expect(metricNames(flagged!)).toContain(metric)
      expect(metricNames(flagged!)).not.toContain(other)
      expect(flagged![metric]).toBe(1)

      output.length = 0
      vi.mocked(runCycle).mockResolvedValueOnce(observed)
      await handler(undefined)

      const [quiet] = metricLines(output)
      expect(metricNames(quiet!)).not.toContain('laggingNodeSkips')
      expect(metricNames(quiet!)).not.toContain('deadlineSkips')
    },
  )

  // a rule that stops matching, or stops delivering part of what it says, is silent otherwise: these two are
  // what an alarm can watch
  it('publishes the rule counters only when a rule was skipped or polled with something dropped', async () => {
    const observed = { ...BUSY, status: 'ok' as const, head: 100, finalized: 36, durableBlock: 30, durableLag: 6 }
    vi.mocked(runCycle).mockResolvedValueOnce({ ...observed, ruleSkips: 1, ruleWarnings: 2 })

    await handler(undefined)

    const [line] = metricLines(output)
    expect(metricNames(line!)).toEqual(expect.arrayContaining(['ruleSkips', 'ruleWarnings']))
    expect(line!.ruleSkips).toBe(1)
    expect(line!.ruleWarnings).toBe(2)

    output.length = 0
    vi.mocked(runCycle).mockResolvedValueOnce(observed)
    await handler(undefined)

    const [quiet] = metricLines(output)
    expect(metricNames(quiet!)).not.toContain('ruleSkips')
    expect(metricNames(quiet!)).not.toContain('ruleWarnings')
  })

  it('logs a cycle line the cycle marked warn at warn', async () => {
    vi.mocked(runCycle).mockImplementation(async (deps: CycleDeps) => {
      deps.log?.('a rule is being polled with part of it dropped', { ruleId: 'r1' }, 'warn')
      return BUSY
    })

    await handler(undefined)

    const warned = output
      .join('\n')
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.message === 'a rule is being polled with part of it dropped')
    expect(warned).toHaveLength(1)
    expect(warned[0]?.level).toBe('WARN')
  })
})

describe('requestTimeoutMs', () => {
  it('splits the time budget over two attempts per URL, between 2 and 10 seconds', () => {
    expect(requestTimeoutMs(50_000, 1)).toBe(10_000)
    expect(requestTimeoutMs(50_000, 3)).toBe(8_333)
    expect(requestTimeoutMs(50_000, 5)).toBe(5_000)
    expect(requestTimeoutMs(50_000, 20)).toBe(2_000)
  })
})
