import { MetricUnit } from '@aws-lambda-powertools/metrics'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { createDispatcherHandler, createSenderHandler } from '../../src/lambda/handlers.js'
import { matchRow, streamRecord } from '../helpers/images.js'

// the real thing, not a stand-in: what the handlers read off the config is what Terraform's variables become,
// and a default that only the fake carried would hide a wiring that never reads the setting
const config = loadConfig({
  TABLE_NAME: 'blockwarden',
  DELIVERY_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/111122223333/deliveries',
  DELIVERY_DLQ_URL: 'https://sqs.us-east-1.amazonaws.com/111122223333/deliveries-dlq',
  AWS_REGION: 'us-east-1',
  ALLOWED_TARGET_ARNS: 'arn:aws:sqs:us-east-1:111122223333:targets',
  OUTBOUND_SECRET_PREFIXES: '/billwarden/',
  RULE_SECRET_PREFIXES: '/bw/rules/',
  TELEGRAM_TOKEN_PARAMETER: '/bw/telegram',
  REAPER_LIMIT: '7',
})

const fakes = () => {
  const ports = {
    dispatchRecords: vi.fn(async () => ({ batchItemFailures: [] })),
    sweepDue: vi.fn(async () => ({ requeued: 2, dead: 1 })),
    acceptOutbound: vi.fn(async () => ({ batchItemFailures: [] })),
    // the empty array below has no context to infer an element type from, so vi.fn would otherwise type this
    // mock's result as `never[]` and refuse the non-empty one `mockResolvedValueOnce` sets below
    processMessages: vi.fn(async () => ({ batchItemFailures: [] as { itemIdentifier: string }[] })),
  }
  const log = vi.fn()
  // strings stand in for the clients and the store: the assertions are about which collaborator was handed on,
  // and a string shows up in a failure message as itself
  const runtime = {
    config,
    store: 'store',
    lookup: 'lookup',
    queue: 'queue',
    deadLetters: 'deadLetters',
    secrets: 'secrets',
    senders: 'senders',
    sqs: 'sqs',
    lambda: 'lambda',
    log,
  }
  // one addMetric across every singleMetric() call, as sender.test.ts does it: a fresh spy per call would let
  // an emission happen and still assert nothing
  const addMetric = vi.fn()
  const addDimension = vi.fn()
  const metrics = { singleMetric: () => ({ addMetric, addDimension }) }
  const dispatcher = createDispatcherHandler(async () => runtime as never, ports as never, metrics as never)
  const sender = createSenderHandler(async () => runtime as never, ports as never, metrics as never)
  return { ports, log, addMetric, addDimension, dispatcher, sender }
}

describe('the dispatcher handler', () => {
  it('sends a stream batch to the dispatcher, with the dead-letter queue', async () => {
    const f = fakes()
    const row = matchRow()
    const records = [streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })]
    await f.dispatcher({ Records: records } as never)
    expect(f.ports.dispatchRecords).toHaveBeenCalledWith(
      {
        store: 'store',
        lookup: 'lookup',
        queue: 'queue',
        deadLetters: 'deadLetters',
        now: expect.any(Function),
        log: f.log,
        ruleSecretPrefixes: ['/bw/rules/'],
      },
      records,
    )
    expect(f.ports.acceptOutbound).not.toHaveBeenCalled()
    expect(f.ports.sweepDue).not.toHaveBeenCalled()
  })

  it('sends an SQS batch to the outbound reader with the configured prefixes', async () => {
    const f = fakes()
    await f.dispatcher({
      Records: [{ eventSource: 'aws:sqs', messageId: 'm1', body: '{"a":1}', receiptHandle: 'r' }],
    } as never)
    expect(f.ports.acceptOutbound).toHaveBeenCalledWith(
      {
        store: 'store',
        queue: 'queue',
        now: expect.any(Function),
        log: f.log,
        allowedSecretPrefixes: ['/billwarden/'],
      },
      [{ messageId: 'm1', body: '{"a":1}' }],
    )
    expect(f.ports.dispatchRecords).not.toHaveBeenCalled()
  })

  it('treats anything else as the scheduled sweep, at the configured limit', async () => {
    const f = fakes()
    await f.dispatcher({ source: 'aws.scheduler' } as never)
    expect(f.ports.sweepDue).toHaveBeenCalledWith(
      {
        store: 'store',
        lookup: 'lookup',
        queue: 'queue',
        deadLetters: 'deadLetters',
        now: expect.any(Function),
        log: f.log,
        ruleSecretPrefixes: ['/bw/rules/'],
      },
      expect.any(Number),
      7,
    )
    expect(f.log).toHaveBeenCalledWith('sweep finished', { requeued: 2, dead: 1 })
  })

  it('treats an empty Records array as the sweep rather than nothing', async () => {
    const f = fakes()
    await f.dispatcher({ Records: [] } as never)
    expect(f.ports.sweepDue).toHaveBeenCalledOnce()
  })

  it('counts the deaths the sweep found, and only when it found some', async () => {
    const f = fakes()
    await f.dispatcher({ Records: [] } as never)
    expect(f.addMetric).toHaveBeenCalledWith('deliveriesDead', MetricUnit.Count, 1)

    const quiet = fakes()
    quiet.ports.sweepDue.mockResolvedValueOnce({ requeued: 0, dead: 0 })
    await quiet.dispatcher({ Records: [] } as never)
    expect(quiet.addMetric).not.toHaveBeenCalled()
  })
})

describe('the sender handler', () => {
  const context = { getRemainingTimeInMillis: () => 12_345 }

  it('passes the batch on with the config and the dead-letter queue, and returns what it reported', async () => {
    const f = fakes()
    f.ports.processMessages.mockResolvedValueOnce({ batchItemFailures: [{ itemIdentifier: 'm2' }] })
    const records = [{ messageId: 'm1', body: '{}' }]
    const response = await f.sender({ Records: records } as never, context)
    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] })
    const [deps, passed, remainingMs] = f.ports.processMessages.mock.calls[0] as never as [
      Record<string, unknown>,
      unknown,
      () => number,
    ]
    expect(passed).toBe(records)
    expect(deps).toMatchObject({
      store: 'store',
      queue: 'queue',
      deadLetters: 'deadLetters',
      senders: 'senders',
      secrets: 'secrets',
      sqs: 'sqs',
      lambda: 'lambda',
      log: f.log,
      region: 'us-east-1',
      allowedTargetArns: ['arn:aws:sqs:us-east-1:111122223333:targets'],
      telegramTokenParameter: '/bw/telegram',
    })
    // the deadline margin is only a margin if the pipeline can read the clock, not a number read once
    expect(remainingMs()).toBe(12_345)
    // nothing was configured for these, so they are absent rather than undefined
    expect(deps).not.toHaveProperty('fromAddress')
    expect(deps).not.toHaveProperty('ses')
  })

  it('counts the failures in a batch, and only when there are some', async () => {
    const f = fakes()
    f.ports.processMessages.mockResolvedValueOnce({ batchItemFailures: [{ itemIdentifier: 'm2' }] })
    await f.sender({ Records: [] } as never, context)
    expect(f.addMetric).toHaveBeenCalledWith('deliveryBatchFailures', MetricUnit.Count, 1)

    const quiet = fakes()
    await quiet.sender({ Records: [] } as never, context)
    expect(quiet.addMetric).not.toHaveBeenCalled()
  })
})

describe('the metrics both handlers emit', () => {
  // a dimension multiplies the billed metric count by its cardinality, and CloudWatch would take it silently
  it('carries no dimension', async () => {
    const f = fakes()
    f.ports.processMessages.mockResolvedValueOnce({ batchItemFailures: [{ itemIdentifier: 'm2' }] })
    await f.dispatcher({ Records: [] } as never)
    await f.sender({ Records: [] } as never, { getRemainingTimeInMillis: () => 1 })
    expect(f.addMetric).toHaveBeenCalledTimes(2)
    expect(f.addDimension).not.toHaveBeenCalled()
  })
})
