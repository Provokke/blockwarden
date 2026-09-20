import type { Metrics } from '@aws-lambda-powertools/metrics'
import { MetricUnit } from '@aws-lambda-powertools/metrics'
import type { DynamoDBBatchResponse, DynamoDBRecord, SQSBatchResponse, SQSRecord } from 'aws-lambda'
import { dispatchRecords, sweepDue } from '../dispatcher.js'
import { acceptOutbound } from '../outbound.js'
import { processMessages, type ProductionSenderPipelineDeps } from '../sender.js'
import type { Runtime } from './runtime.js'

type Ports = {
  dispatchRecords: typeof dispatchRecords
  sweepDue: typeof sweepDue
  acceptOutbound: typeof acceptOutbound
  processMessages: typeof processMessages
}

export const realPorts: Ports = { dispatchRecords, sweepDue, acceptOutbound, processMessages }

type AnyEvent = { Records?: { eventSource?: string }[] }

// the one field of the Lambda context the sender's deadline margin needs, as the relayer's own entries take it
type Context = { getRemainingTimeInMillis(): number }

export function createDispatcherHandler(runtime: () => Promise<Runtime>, ports: Ports, metrics: Metrics) {
  return async (event: AnyEvent): Promise<DynamoDBBatchResponse | SQSBatchResponse | void> => {
    const r = await runtime()
    const records = event.Records ?? []
    const [first] = records
    if (first?.eventSource === 'aws:dynamodb') {
      return ports.dispatchRecords(
        {
          store: r.store,
          lookup: r.lookup,
          queue: r.queue,
          deadLetters: r.deadLetters,
          now: () => new Date(),
          log: r.log,
        },
        records as DynamoDBRecord[],
      )
    }
    if (first?.eventSource === 'aws:sqs') {
      return ports.acceptOutbound(
        {
          store: r.store,
          queue: r.queue,
          now: () => new Date(),
          log: r.log,
          allowedSecretPrefixes: r.config.outboundSecretPrefixes,
        },
        (records as SQSRecord[]).map((record) => ({ messageId: record.messageId, body: record.body })),
      )
    }
    // the one-minute schedule: anything with no records at all
    const summary = await ports.sweepDue(
      {
        store: r.store,
        lookup: r.lookup,
        queue: r.queue,
        deadLetters: r.deadLetters,
        now: () => new Date(),
        log: r.log,
      },
      Date.now(),
      r.config.reaperLimit,
    )
    r.log('sweep finished', summary)
    // a billed custom metric, so it is published only when something actually died
    if (summary.dead > 0) metrics.singleMetric().addMetric('deliveriesDead', MetricUnit.Count, summary.dead)
  }
}

export function createSenderHandler(runtime: () => Promise<Runtime>, ports: Ports, metrics: Metrics) {
  return async (event: { Records: SQSRecord[] }, context: Context): Promise<SQSBatchResponse> => {
    const r = await runtime()
    // required so a caller that forgets it fails to compile; a batch cannot time out after its sends already
    // happened, which is exactly what an omitted margin would let happen
    const remainingMs = () => context.getRemainingTimeInMillis()
    // built as the narrower production type: `resolve` and `post` are test-only injection points, and naming
    // either one here would be an excess-property error rather than a silent bypass of the destination guard
    const deps: ProductionSenderPipelineDeps = {
      store: r.store,
      queue: r.queue,
      deadLetters: r.deadLetters,
      senders: r.senders,
      secrets: r.secrets,
      now: () => Date.now(),
      log: r.log,
      region: r.config.region,
      allowedTargetArns: r.config.allowedTargetArns,
      sqs: r.sqs,
      lambda: r.lambda,
      metrics,
      ...(r.ses ? { ses: r.ses } : {}),
      ...pick(
        r.config,
        'fromAddress',
        'configurationSet',
        'telegramTokenParameter',
        'relayerApiUrl',
        'relayerApiKeyParameter',
        'defaultWebhookSecretParameter',
      ),
    }
    const response = await ports.processMessages(deps, event.Records, remainingMs)
    if (response.batchItemFailures.length > 0) {
      metrics.singleMetric().addMetric('deliveryBatchFailures', MetricUnit.Count, response.batchItemFailures.length)
    }
    return response
  }
}

function pick<T extends object, K extends keyof T>(source: T, ...names: K[]): Partial<Pick<T, K>> {
  return Object.fromEntries(names.filter((n) => source[n] !== undefined).map((n) => [n, source[n]])) as Partial<
    Pick<T, K>
  >
}
