import {
  assignOrdinals,
  buildLogFilter,
  compileRule,
  DeadlineError,
  fetchLogsAdaptive,
  matchKey,
  matchLog,
  type CompiledRule,
  type KeyedMatch,
  type LogFilter,
  type RawLog,
} from '@blockwarden/core'
import { randomUUID } from 'node:crypto'
import { isHalvableError, LaggingNodeError, type ChainReader } from './chain.js'
import { CursorConflictError, type Cursor, type MonitorStorePort, type NewMatch } from './store.js'

export const FAST_OVERLAP = 20
export const FAST_MAX_RANGE = 2000
export const DROP_AFTER_BLOCKS = 64
export const LEASE_MS = 90_000

export type CycleDeps = {
  chainId: number
  chain: ChainReader
  store: MonitorStorePort
  maxRange: number
  timeBudgetMs: number
  // absolute epoch milliseconds; the cycle stops at the earlier of this and the end of its time budget
  deadlineMs?: number
  startBlock?: number
  finalityDepth?: number
  now?: () => number
  log?: (message: string, data?: Record<string, unknown>) => void
  owner?: string
  leaseMs?: number
}

export type CycleResult = {
  status: 'ok' | 'busy' | 'conflict'
  head: number
  finalized: number | undefined
  finalizedAgeSeconds: number | undefined
  durableBlock: number
  fastBlock: number
  durableLag: number | undefined
  final: number
  provisional: number
  dropped: number
  laggingNode: boolean
  deadlineHit: boolean
}

type Log = NonNullable<CycleDeps['log']>

export async function runCycle(deps: CycleDeps): Promise<CycleResult> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const owner = deps.owner ?? randomUUID()
  if (!(await deps.store.acquireLease(deps.chainId, owner, now(), deps.leaseMs ?? LEASE_MS))) {
    return nothingObserved('busy')
  }
  let result: CycleResult
  try {
    result = await poll(deps, now, log)
  } catch (err) {
    try {
      await deps.store.releaseLease(deps.chainId, owner)
    } catch (releaseErr) {
      log('releasing the lease failed after the cycle failed', {
        chainId: deps.chainId,
        error: (releaseErr as Error).message,
      })
    }
    throw err
  }
  await deps.store.releaseLease(deps.chainId, owner)
  return result
}

async function poll(deps: CycleDeps, now: () => number, log: Log): Promise<CycleResult> {
  const { chainId, chain, store } = deps
  const started = now()
  const deadline = Math.min(started + deps.timeBudgetMs, deps.deadlineMs ?? Number.POSITIVE_INFINITY)
  const inTime = () => now() < deadline
  const shouldStop = () => !inTime()
  const rules = await loadRules(deps, log)
  const fastRules = rules.filter((r) => r.confirmation.mode === 'fast')

  let head: number
  let finalized: number | undefined
  let finalizedAgeSeconds: number | undefined
  try {
    head = await chain.getHead()
    if (deps.finalityDepth !== undefined) {
      finalized = Math.max(0, head - deps.finalityDepth)
    } else {
      const fin = await chain.getFinalized()
      if (fin) {
        finalized = fin.number
        finalizedAgeSeconds = Math.floor(now() / 1000) - fin.timestamp
      } else {
        // guessing a depth would let the durable scan write final records from blocks that can still reorg
        log('finalized block is unavailable, skipping the durable scan and drops this run', { chainId })
      }
    }
  } catch (err) {
    if (!(err instanceof DeadlineError)) throw err
    log('the hard stop passed while reading the head or the finalized block, stopping this run', { chainId })
    return { ...nothingObserved('ok'), deadlineHit: true }
  }

  const firstSeenAt = new Date(now()).toISOString()
  const counts = { final: 0, provisional: 0, dropped: 0 }
  let laggingNode = false
  let deadlineHit = false
  const report = (status: CycleResult['status'], at: Pick<Cursor, 'durableBlock' | 'fastBlock'>): CycleResult => ({
    status,
    head,
    finalized,
    finalizedAgeSeconds,
    durableBlock: at.durableBlock,
    fastBlock: at.fastBlock,
    durableLag: finalized === undefined ? undefined : Math.max(0, finalized - at.durableBlock),
    ...counts,
    laggingNode,
    deadlineHit,
  })

  const stored = await store.getCursor(chainId)
  let cursor: Cursor
  if (stored) {
    cursor = stored
  } else if (deps.startBlock !== undefined) {
    cursor = { durableBlock: deps.startBlock, fastBlock: deps.startBlock, version: 0 }
  } else if (finalized !== undefined) {
    cursor = { durableBlock: finalized, fastBlock: head, version: 0 }
  } else {
    // starting at the head would skip the blocks between finalized and the head for good once finalized returns
    log('finalized block is unavailable and no start block is set, waiting to create the cursor', { chainId })
    return report('ok', { durableBlock: 0, fastBlock: 0 })
  }
  const finish = (status: CycleResult['status']) => report(status, cursor)

  try {
    if (cursor.version === 0) cursor = await store.saveCursor(chainId, cursor)

    if (finalized !== undefined) {
      const filter = buildLogFilter(rules)
      // a range the RPC refused is likely refused again, so the next range starts at the size that fitted
      let span = deps.maxRange
      try {
        while (cursor.durableBlock < finalized) {
          if (!inTime()) {
            deadlineHit = true
            break
          }
          if (!filter) {
            // there is nothing to read, so one write moves the cursor all the way
            cursor = await store.saveCursor(chainId, { ...cursor, durableBlock: finalized })
            continue
          }
          const from = cursor.durableBlock + 1
          const to = Math.min(finalized, cursor.durableBlock + span)
          await fetchLogsAdaptive(
            from,
            to,
            (f, t) => readFinalRange(chain, filter, f, t, shouldStop),
            isHalvableError,
            {
              shouldStop,
              // a transaction's logs share one block and a sub-range never splits a block, so ordinals stay whole
              onChunk: async (f, t, logs) => {
                for (const match of assignOrdinals(logs.flatMap((l) => matchLog(rules, l)))) {
                  if ((await store.writeFinal(toNewMatch(chainId, match, firstSeenAt))) !== 'unchanged') counts.final++
                }
                cursor = await store.saveCursor(chainId, { ...cursor, durableBlock: t })
                // a range read whole may mean the node recovered, so the size grows back towards maxRange
                span = f === from && t === to ? Math.min(deps.maxRange, span * 2) : t - f + 1
              },
            },
          )
        }
      } catch (err) {
        if (err instanceof LaggingNodeError) {
          log('RPC node is behind the durable range, stopping the durable scan this run', {
            chainId,
            head: err.head,
            to: err.to,
          })
          laggingNode = true
        } else if (err instanceof DeadlineError) {
          log('the deadline passed inside a durable range, stopping the durable scan this run', {
            chainId,
            durableBlock: cursor.durableBlock,
          })
          deadlineHit = true
        } else {
          throw err
        }
      }
      if (cursor.durableBlock >= DROP_AFTER_BLOCKS && inTime()) {
        counts.dropped += await store.dropStaleProvisional(chainId, cursor.durableBlock - DROP_AFTER_BLOCKS)
      }
    }

    if (fastRules.length > 0 && !inTime()) {
      deadlineHit = true
    } else if (fastRules.length > 0) {
      let from = Math.max(cursor.durableBlock, cursor.fastBlock - FAST_OVERLAP)
      if (head - from > FAST_MAX_RANGE) from = head - FAST_MAX_RANGE
      if (from < head) {
        // saved before reading, so a run that stops before its first chunk still lowers the cursor to the head
        if (head < cursor.fastBlock) cursor = await store.saveCursor(chainId, { ...cursor, fastBlock: head })
        const filter = buildLogFilter(fastRules)!
        let reached = from
        try {
          // a chunk never splits a block, so ordinals computed per chunk match the durable scan's
          while (reached < head) {
            const end = Math.min(head, reached + deps.maxRange)
            const logs = await fetchLogs(chain, filter, reached + 1, end, shouldStop)
            for (const match of assignOrdinals(logs.flatMap((l) => matchLog(fastRules, l)))) {
              if (await store.writeProvisional(toNewMatch(chainId, match, firstSeenAt))) counts.provisional++
            }
            reached = end
          }
        } catch (err) {
          if (!(err instanceof DeadlineError)) throw err
          log('the deadline passed inside the fast scan, stopping it this run', { chainId, fastBlock: reached })
          deadlineHit = true
        }
        // the overlap starts behind the cursor, so a run stopped inside it must not pull the cursor back
        const fastBlock = Math.max(cursor.fastBlock, reached)
        // saved once, not per chunk, so a narrow maxRange does not multiply cursor writes
        if (reached > from && fastBlock !== cursor.fastBlock) {
          cursor = await store.saveCursor(chainId, { ...cursor, fastBlock })
        }
      } else if (head < cursor.fastBlock) {
        cursor = await store.saveCursor(chainId, { ...cursor, fastBlock: head })
      }
    }

    return finish('ok')
  } catch (err) {
    if (err instanceof CursorConflictError) {
      log('cursor was saved by another invocation, stopping', { chainId })
      return finish('conflict')
    }
    throw err
  }
}

function nothingObserved(status: CycleResult['status']): CycleResult {
  return {
    status,
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
}

function fetchLogs(chain: ChainReader, filter: LogFilter, from: number, to: number, shouldStop: () => boolean) {
  return fetchLogsAdaptive(from, to, (f, t) => chain.getLogs(filter, f, t), isHalvableError, { shouldStop })
}

// Erigon, Besu and reth answer a range past their head with fewer logs instead of an error
async function readFinalRange(
  chain: ChainReader,
  filter: LogFilter,
  from: number,
  to: number,
  shouldStop: () => boolean,
): Promise<RawLog[]> {
  const { logs, head, headBefore } = await chain.getLogsWithHead(filter, from, to, { shouldStop })
  // both heads, because a node that runs batch entries concurrently can read the batched head after the logs
  if (head < to || headBefore < to) throw new LaggingNodeError(Math.min(head, headBefore), to)
  return logs
}

async function loadRules(deps: CycleDeps, log: Log): Promise<CompiledRule[]> {
  const stored = await deps.store.listActiveRules(deps.chainId)
  return stored.flatMap((rule) => {
    try {
      return [compileRule(rule.ruleId, rule.input)]
    } catch (err) {
      log('skipping a rule that no longer compiles', { ruleId: rule.ruleId, error: (err as Error).message })
      return []
    }
  })
}

function toNewMatch(chainId: number, match: KeyedMatch, firstSeenAt: string): NewMatch {
  const { log, rule, args, ordinal } = match
  return {
    matchKey: matchKey(chainId, log.transactionHash, ordinal, rule.ruleId),
    ruleId: rule.ruleId,
    chainId,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    ordinal,
    address: log.address,
    args,
    firstSeenAt,
  }
}
