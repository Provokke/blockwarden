import { randomUUID } from 'node:crypto'
import type { Logger } from '@aws-lambda-powertools/logger'
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics'
import { describeError } from '../chain.js'
import type { ChainConfig } from '../config.js'
import type { SignerRecord } from '../records.js'
import { sweepChain } from '../sweeper.js'
import { createLogger, createRuntime, once, type Runtime } from './runtime.js'

// no new transactions this close to the timeout, leaving time for the balance reads
const DEADLINE_MARGIN_MS = 8_000
// a chain still running this close is abandoned, so one slow RPC cannot lose every chain's metrics
const HARD_STOP_MARGIN_MS = 3_000

type Context = { getRemainingTimeInMillis(): number }

class DeadlineError extends Error {}

export function createSweeperHandler(runtime: () => Promise<Runtime>, logger: Logger, metrics: Metrics) {
  return async (_event: unknown, context: Context): Promise<void> => {
    const { config, store, chains, queue, accountFor, log } = await runtime()
    const now = Date.now()
    const remainingMs = context.getRemainingTimeInMillis()
    const deadlineMs = now + remainingMs - DEADLINE_MARGIN_MS
    const hardStopMs = now + remainingMs - HARD_STOP_MARGIN_MS
    // any failure fails the invocation so the Errors alarm fires; kept as describeError text, since the runtime logs
    // a thrown error's message and a viem message can hold the RPC URL's API key
    const failures: string[] = []
    // chains whose sweep finished but left transactions it could not settle; a fault that hits every transaction,
    // such as a broken KMS grant, must still fail the invocation
    const erroredChains: number[] = []

    // read once for all chains, alongside the sweeps
    const signersRead = readSigners()

    async function readSigners(): Promise<SignerRecord[]> {
      const found: SignerRecord[] = []
      try {
        for (const signerId of config.signerIds) {
          const signer = await store.getSigner(signerId)
          // either way a balance alarm is left without data, which CloudWatch does not treat as breaching
          if (!signer) {
            logger.error('balance not reported: no such signer', { signerId })
            failures.push(`signer ${signerId} does not exist`)
            continue
          }
          const unswept = signer.chainIds.filter((chainId) => !chains.has(chainId))
          if (unswept.length > 0) {
            logger.error('balance not reported: the signer lists chains this sweeper does not sweep', {
              signerId,
              chainIds: unswept,
            })
            failures.push(`signer ${signerId} lists unswept chains ${unswept.join(', ')}`)
          }
          found.push(signer)
        }
      } catch (err) {
        logger.error('reading signers failed', { error: describeError(err) })
        failures.push(`reading signers failed: ${describeError(err)}`)
      }
      return found
    }

    async function sweepOne(settings: ChainConfig): Promise<void> {
      const chain = chains.get(settings.chainId)!
      const summary = await sweepChain(
        {
          store,
          chain,
          settings,
          accountFor,
          queue,
          now: () => new Date(),
          requeueAfterMs: config.requeueAfterMs,
          newTxId: randomUUID,
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

      for (const signer of await signersRead) {
        // a signer on only some of the chains is ordinary
        if (!signer.chainIds.includes(settings.chainId)) continue
        try {
          const balance = await chain.getBalance((await accountFor(signer)).address)
          const perSigner = metrics.singleMetric()
          perSigner.addDimensions({ chainId: String(settings.chainId), signerId: signer.signerId })
          // gwei keeps the value well inside the precision CloudWatch stores
          perSigner.addMetric('signerBalanceGwei', MetricUnit.Count, Number(balance / 1_000_000_000n))
        } catch (err) {
          // one signer's KMS or RPC trouble must not hide the others' balances
          const error = describeError(err)
          logger.error('balance read failed', { chainId: settings.chainId, signerId: signer.signerId, error })
          failures.push(`balance read failed on chain ${settings.chainId} for signer ${signer.signerId}: ${error}`)
        }
      }
    }

    // in parallel, so a slow chain cannot starve the rest; an abandoned chain may keep writing, but every write is
    // conditioned on the version it read
    const outcomes = await Promise.allSettled(
      config.chains.map((settings) => beforeHardStop(sweepOne(settings), hardStopMs)),
    )
    outcomes.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') return
      const chainId = config.chains[i]!.chainId
      if (outcome.reason instanceof DeadlineError) {
        logger.error('sweep failed', { chainId, error: 'did not finish before the deadline' })
        failures.push(`chain ${chainId} did not finish before the deadline`)
        return
      }
      const error = describeError(outcome.reason)
      logger.error('sweep failed', { chainId, error })
      failures.push(`chain ${chainId} failed: ${error}`)
    })
    if (erroredChains.length > 0) {
      logger.error('sweep left transaction errors', { chainIds: erroredChains })
      failures.push(`sweep left transaction errors on chains ${erroredChains.join(', ')}`)
    }
    if (failures.length > 0) throw new Error(`sweep failed: ${failures.join('; ')}`)
  }
}

function beforeHardStop<T>(work: Promise<T>, hardStopMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError()), Math.max(0, hardStopMs - Date.now()))
  })
  return Promise.race([work, stop]).finally(() => clearTimeout(timer))
}

const logger = createLogger('blockwarden-relayer-sweeper')

export const handler = createSweeperHandler(
  once(() => createRuntime(logger, 'sweeper')),
  logger,
  new Metrics({ namespace: 'Blockwarden', serviceName: 'relayer' }),
)
