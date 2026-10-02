import { describe, expect, it, vi } from 'vitest'
import { createDispatcherHandler, createSenderHandler } from '../../src/lambda/handlers.js'
import { matchRow, streamRecord } from '../helpers/images.js'

const runtime = () => {
  const dispatchRecords = vi.fn(async () => ({ batchItemFailures: [] }))
  const sweepDue = vi.fn(async () => ({ requeued: 2, dead: 1 }))
  const acceptOutbound = vi.fn(async () => ({ batchItemFailures: [] }))
  // the empty array below has no context to infer an element type from, so vi.fn would otherwise type this
  // mock's result as `never[]` and refuse the non-empty one `mockResolvedValueOnce` sets below
  const processMessages = vi.fn(async () => ({ batchItemFailures: [] as { itemIdentifier: string }[] }))
  return { dispatchRecords, sweepDue, acceptOutbound, processMessages }
}

const metrics = () => ({ singleMetric: () => ({ addMetric: vi.fn(), addDimension: vi.fn() }) })

describe('the dispatcher handler', () => {
  it('sends a stream batch to the dispatcher', async () => {
    const r = runtime()
    const handler = createDispatcherHandler(async () => ({}) as never, r as never, metrics() as never)
    const row = matchRow()
    await handler({
      Records: [streamRecord('INSERT', { PK: row.PK as string, SK: 'META' }, { newImage: row })],
    } as never)
    expect(r.dispatchRecords).toHaveBeenCalledOnce()
    expect(r.acceptOutbound).not.toHaveBeenCalled()
    expect(r.sweepDue).not.toHaveBeenCalled()
  })

  it('sends an SQS batch to the outbound reader', async () => {
    const r = runtime()
    const handler = createDispatcherHandler(async () => ({}) as never, r as never, metrics() as never)
    await handler({ Records: [{ eventSource: 'aws:sqs', messageId: 'm1', body: '{}' }] } as never)
    expect(r.acceptOutbound).toHaveBeenCalledOnce()
    expect(r.dispatchRecords).not.toHaveBeenCalled()
  })

  it('treats anything else as the scheduled sweep', async () => {
    const r = runtime()
    const handler = createDispatcherHandler(async () => ({}) as never, r as never, metrics() as never)
    await handler({ source: 'aws.scheduler' } as never)
    expect(r.sweepDue).toHaveBeenCalledOnce()
  })

  it('treats an empty Records array as the sweep rather than nothing', async () => {
    const r = runtime()
    const handler = createDispatcherHandler(async () => ({}) as never, r as never, metrics() as never)
    await handler({ Records: [] } as never)
    expect(r.sweepDue).toHaveBeenCalledOnce()
  })
})

describe('the sender handler', () => {
  it('passes the batch on and returns what it reported', async () => {
    const r = runtime()
    r.processMessages.mockResolvedValueOnce({ batchItemFailures: [{ itemIdentifier: 'm2' }] })
    const handler = createSenderHandler(async () => ({}) as never, r as never, metrics() as never)
    const response = await handler({ Records: [{ messageId: 'm1', body: '{}' }] } as never)
    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] })
  })
})
