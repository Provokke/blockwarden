import type { Logger } from '@aws-lambda-powertools/logger'
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics'
import { describeError } from '../chain.js'
import { sweepChain } from '../sweeper.js'
import { createLogger, createRuntime, once, type Runtime } from './runtime.js'

// leaves time for the balance reads and the last log lines after the sweeps stop
const DEADLINE_MARGIN_MS = 8_000

type Context = { getRemainingTimeInMillis(): number }

export function createSweeperHandler(runtime: () => Promise<Runtime>, logger: Logger, metrics: Metrics) {
  return async (_event: unknown, context?: Context): Promise<void> => {
    const { config, store, chains, queue, accountFor, log } = await runtime()
    const remaining = context?.getRemainingTimeInMillis()
    const deadlineMs = Date.now() + (remaining === undefined ? config.timeBudgetMs : remaining - DEADLINE_MARGIN_MS)
    let failure: unknown
    // chains whose sweep finished but left transactions it could not settle; a fault that hits every transaction,
    // such as a broken KMS grant, must still fail the invocation so the Lambda Errors alarm fires
    const erroredChains: number[] = []
    for (const settings of config.chains) {
      const chain = chains.get(settings.chainId)!
      try {
        const summary = await sweepChain(
          {
            store,
            chain,
            settings,
            accountFor,
            queue,
            now: () => new Date(),
            requeueAfterMs: config.requeueAfterMs,
            log,
          },
          deadlineMs,
        )
        logger.info('sweep finished', { chainId: settings.chainId, ...summary })
        if (summary.errors > 0) erroredChains.push(settings.chainId)
        // a single metric publishes at once, with its own dimensions plus the service dimension
        const perChain = metrics.singleMetric()
        perChain.addDimension('chainId', String(settings.chainId))
        perChain.addMetric('pendingAgeSeconds', MetricUnit.Seconds, summary.oldestPendingSeconds)

        for (const signerId of config.signerIds) {
          const signer = await store.getSigner(signerId)
          if (!signer?.chainIds.includes(settings.chainId)) continue
          const balance = await chain.getBalance((await accountFor(signer)).address)
          const perSigner = metrics.singleMetric()
          perSigner.addDimensions({ chainId: String(settings.chainId), signerId })
          // gwei keeps the value well inside the precision CloudWatch stores
          perSigner.addMetric('signerBalanceGwei', MetricUnit.Count, Number(balance / 1_000_000_000n))
        }
      } catch (err) {
        // one chain's RPC outage must not stop the sweep of the others; the error still fails the invocation
        logger.error('sweep failed', { chainId: settings.chainId, error: describeError(err) })
        failure ??= err
      }
    }
    if (erroredChains.length > 0) {
      logger.error('sweep left transaction errors', { chainIds: erroredChains })
      failure ??= new Error(`sweep left transaction errors on chains ${erroredChains.join(', ')}`)
    }
    if (failure) throw failure
  }
}

const logger = createLogger('blockwarden-relayer-sweeper')

export const handler = createSweeperHandler(
  once(() => createRuntime(logger)),
  logger,
  new Metrics({ namespace: 'Blockwarden', serviceName: 'relayer' }),
)
