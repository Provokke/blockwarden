import fc from 'fast-check'
import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { DeadlineError, fetchLogsAdaptive } from '../src/fetch-logs.js'
import type { RawLog } from '../src/types.js'

function logsFor(from: number, to: number): RawLog[] {
  const logs: RawLog[] = []
  for (let n = from; n <= to; n++) {
    logs.push({
      address: `0x${'aa'.repeat(20)}`,
      topics: [],
      data: '0x',
      blockNumber: n,
      blockHash: `0x${n.toString(16).padStart(64, '0')}` as Hex,
      transactionHash: `0x${'22'.repeat(32)}`,
      logIndex: 0,
    })
  }
  return logs
}

describe('fetchLogsAdaptive', () => {
  it('covers every block in order when the node caps the range', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 3_000 }),
        fc.integer({ min: 1, max: 500 }),
        async (from, span, limit) => {
          const to = from + span
          let calls = 0
          const fetchRange = async (f: number, t: number) => {
            calls++
            if (t - f + 1 > limit) throw new Error('block range too large')
            return logsFor(f, t)
          }
          const logs = await fetchLogsAdaptive(from, to, fetchRange, () => true)
          expect(logs.map((l) => l.blockNumber)).toEqual(logsFor(from, to).map((l) => l.blockNumber))
          expect(calls).toBeLessThanOrEqual(2 * (span + 1))
        },
      ),
      { numRuns: 200 },
    )
  })

  it('rethrows errors that are not about the range without splitting', async () => {
    let calls = 0
    const boom = new Error('connection refused')
    const fetchRange = async () => {
      calls++
      throw boom
    }
    await expect(fetchLogsAdaptive(1, 100, fetchRange, (err) => err !== boom)).rejects.toBe(boom)
    expect(calls).toBe(1)
  })

  it('rethrows when a single block is still refused', async () => {
    const fetchRange = async () => {
      throw new Error('block range too large')
    }
    await expect(fetchLogsAdaptive(5, 8, fetchRange, () => true)).rejects.toThrow('block range too large')
  })

  it('hands every leaf to onChunk in order, and a stop before any sub-range fetch keeps the completed prefix', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1_000 }),
        fc.integer({ min: 0, max: 300 }),
        fc.integer({ min: 1, max: 40 }),
        fc.option(fc.integer({ min: 1, max: 30 }), { nil: undefined }),
        async (from, span, limit, stopAfterFetches) => {
          const to = from + span
          let fetches = 0
          const chunks: [number, number][] = []
          const fetchRange = async (f: number, t: number) => {
            fetches++
            if (t - f + 1 > limit) throw new Error('block range too large')
            return logsFor(f, t)
          }
          const outcome = await fetchLogsAdaptive(from, to, fetchRange, () => true, {
            shouldStop: () => stopAfterFetches !== undefined && fetches >= stopAfterFetches,
            onChunk: async (f, t, logs) => {
              expect(logs.map((l) => l.blockNumber)).toEqual(logsFor(f, t).map((l) => l.blockNumber))
              chunks.push([f, t])
            },
          }).then(
            (logs) => ({ logs }),
            (err: unknown) => ({ err }),
          )

          let next = from
          for (const [f, t] of chunks) {
            expect(f).toBe(next)
            expect(t - f + 1).toBeLessThanOrEqual(limit)
            next = t + 1
          }
          if ('err' in outcome) {
            expect(outcome.err).toBeInstanceOf(DeadlineError)
            expect(fetches).toBe(stopAfterFetches)
            expect(next).toBeLessThanOrEqual(to)
          } else {
            expect(next).toBe(to + 1)
            expect(outcome.logs.map((l) => l.blockNumber)).toEqual(logsFor(from, to).map((l) => l.blockNumber))
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('checks shouldStop before the first fetch', async () => {
    let calls = 0
    const fetchRange = async () => {
      calls++
      return []
    }
    await expect(fetchLogsAdaptive(1, 10, fetchRange, () => true, { shouldStop: () => true })).rejects.toBeInstanceOf(
      DeadlineError,
    )
    expect(calls).toBe(0)
  })

  it('keeps the chunks before a single block the node still refuses', async () => {
    const chunks: [number, number][] = []
    const fetchRange = async (f: number, t: number) => {
      if (t - f + 1 > 2 || (f <= 7 && t >= 7)) throw new Error('block range too large')
      return logsFor(f, t)
    }
    await expect(
      fetchLogsAdaptive(1, 8, fetchRange, () => true, { onChunk: (f, t) => void chunks.push([f, t]) }),
    ).rejects.toThrow('block range too large')
    expect(chunks).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ])
  })

  it('never halves or refetches because onChunk failed', async () => {
    let calls = 0
    const fetchRange = async (f: number, t: number) => {
      calls++
      return logsFor(f, t)
    }
    const saveFailed = new Error('save failed')
    await expect(
      fetchLogsAdaptive(1, 8, fetchRange, () => true, {
        onChunk: () => {
          throw saveFailed
        },
      }),
    ).rejects.toBe(saveFailed)
    expect(calls).toBe(1)
  })
})
