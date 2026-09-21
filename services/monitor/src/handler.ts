import { Logger } from '@aws-lambda-powertools/logger'
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { createDocumentClient } from '@blockwarden/dynamo'
import { createChainReader, type ChainReader } from './chain.js'
import { loadConfig, type MonitorConfig } from './config.js'
import { runCycle, type CycleResult } from './cycle.js'
import { redactData, redactError, redactUrls } from './redact.js'
import { MonitorStore } from './store.js'

const logger = new Logger({ serviceName: 'blockwarden-monitor' })
const metrics = new Metrics({ namespace: 'Blockwarden', serviceName: 'monitor' })

type Runtime = { config: MonitorConfig; store: MonitorStore; chain: ChainReader }

// Built once per warm Lambda so the SSM read and HTTP clients are reused between invocations.
let runtime: Promise<Runtime> | undefined

// every URL gets two attempts, so a list of dead RPCs still fails inside the time budget
export function requestTimeoutMs(budgetMs: number, urlCount: number): number {
  return Math.max(2_000, Math.min(10_000, Math.floor(budgetMs / (2 * urlCount))))
}

async function init(): Promise<Runtime> {
  const config = await loadConfig(process.env)
  const endpoint = process.env.DYNAMODB_ENDPOINT
  const doc = createDocumentClient(new DynamoDBClient(endpoint ? { endpoint } : {}))
  const chain = createChainReader(config.rpcUrls, requestTimeoutMs(config.timeBudgetMs, config.rpcUrls.length))
  const store = new MonitorStore(doc, config.tableName, () => new Date(), {
    log: (message, data) => logger.info(message, data ?? {}),
  })
  return { config, store, chain }
}

// leaves time to release the lease and publish metrics before Lambda stops the invocation
const DEADLINE_MARGIN_MS = 8_000
// leaves time to release the lease and publish metrics after the hard stop aborts a request
const HARD_STOP_MARGIN_MS = 3_000
// without a Lambda context nothing stops the invocation, so the hard stop only has to sit past the time budget
const HARD_STOP_SLACK_MS = 5_000

export async function handler(_event: unknown, context?: { getRemainingTimeInMillis(): number }): Promise<CycleResult> {
  runtime ??= init().catch((err: unknown) => {
    runtime = undefined
    throw err
  })
  const { config, store, chain } = await runtime

  metrics.addDimension('chainId', String(config.chainId))
  // a warm reader would otherwise trust a head from an earlier invocation, perhaps from a node since swapped
  // behind the same URL; it costs one eth_blockNumber per node per run
  chain.resetRememberedHeads()
  const redact = (text: string) => redactUrls(text, config.rpcUrls)
  const now = Date.now()
  const remainingMs = context?.getRemainingTimeInMillis()
  const deadlineMs = remainingMs === undefined ? now + config.timeBudgetMs : now + remainingMs - DEADLINE_MARGIN_MS
  // the deadline is only checked between requests; this aborts a request still running when the invocation must end
  chain.setHardStop(
    remainingMs === undefined
      ? now + config.timeBudgetMs + HARD_STOP_SLACK_MS
      : now + remainingMs - HARD_STOP_MARGIN_MS,
  )
  try {
    let result: CycleResult
    try {
      result = await runCycle({
        chainId: config.chainId,
        chain,
        store,
        maxRange: config.maxRange,
        timeBudgetMs: config.timeBudgetMs,
        deadlineMs,
        startBlock: config.startBlock,
        finalityDepth: config.finalityDepth,
        log: (message, data, level) => {
          const line = redactData(data ?? {}, config.rpcUrls) as Record<string, unknown>
          if (level === 'warn') logger.warn(redact(message), line)
          else logger.info(redact(message), line)
        },
      })
    } catch (err) {
      // viem puts the full RPC URL, API key included, in its error messages and stacks
      const { message, stack } = redactError(err, config.rpcUrls)
      logger.error('cycle failed', { error: message, stack })
      const safe = new Error(message)
      if (err instanceof Error) safe.name = err.name
      safe.stack = stack ?? `${safe.name}: ${message}`
      throw safe
    }
    if (result.status === 'busy') {
      // Another invocation holds this chain's lease, so this run observed nothing about the chain.
      metrics.addMetric('busySkips', MetricUnit.Count, 1)
    } else {
      if (result.durableLag !== undefined) metrics.addMetric('durableLag', MetricUnit.Count, result.durableLag)
      if (result.finalizedAgeSeconds !== undefined) {
        metrics.addMetric('finalizedAgeSeconds', MetricUnit.Seconds, result.finalizedAgeSeconds)
      }
      // match counts stay in the cycle finished log below: past ten custom metrics each costs $0.30 a month
      // no alarms of their own: a node that keeps lagging, or runs that keep running out of time, trip durableLag
      if (result.laggingNode) metrics.addMetric('laggingNodeSkips', MetricUnit.Count, 1)
      if (result.deadlineHit) metrics.addMetric('deadlineSkips', MetricUnit.Count, 1)
      // a rule that no longer compiles has left the poll, and one polled with an action dropped delivers less
      // than it says; both are otherwise only a log line, so an alarm needs these. Published only when they
      // happen, as every other count here is, because a custom metric is billed per name.
      if (result.ruleSkips > 0) metrics.addMetric('ruleSkips', MetricUnit.Count, result.ruleSkips)
      if (result.ruleWarnings > 0) metrics.addMetric('ruleWarnings', MetricUnit.Count, result.ruleWarnings)
    }
    logger.info('cycle finished', { ...result })
    return result
  } finally {
    metrics.publishStoredMetrics()
  }
}
