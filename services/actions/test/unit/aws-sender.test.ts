import {
  InvalidParameterValueException,
  LambdaServiceException,
  ResourceNotFoundException as LambdaResourceNotFoundException,
  type InvokeCommand,
} from '@aws-sdk/client-lambda'
import {
  InvalidAddress,
  InvalidMessageContents,
  InvalidSecurity,
  KmsAccessDenied,
  QueueDoesNotExist,
  ResourceNotFoundException as SqsResourceNotFoundException,
  SQSServiceException,
  UnsupportedOperation,
  type SendMessageCommand,
} from '@aws-sdk/client-sqs'
import { describe, expect, it, vi } from 'vitest'
import { queueUrlFromArn, sendLambda, sendSqs } from '../../src/senders/aws.js'
import type { DeliveryRecord } from '../../src/records.js'

const QUEUE = 'arn:aws:sqs:us-east-1:111122223333:ingest'
const FUNCTION = 'arn:aws:lambda:us-east-1:111122223333:function:ingest'

const delivery = (target: DeliveryRecord['target']): DeliveryRecord => ({
  deliveryId: 'dlv_aws',
  subject: 'MATCH#0xabc',
  actionId: 'a_1111111111111111',
  event: 'match.final',
  seq: 0,
  channel: target.channel,
  target,
  payload: '{"id":"dlv_aws","type":"match.final"}',
  status: 'delivering',
  attempts: 1,
  createdAt: 'now',
  updatedAt: 'now',
  version: 1,
  expiresAt: 0,
})

const deps = (send: unknown, allowed: string[] = [QUEUE, FUNCTION], overrides: Record<string, unknown> = {}) =>
  ({
    secrets: { read: async () => ['x'] },
    now: () => 0,
    log: vi.fn(),
    region: 'us-east-1',
    allowedTargetArns: allowed,
    sqs: { send },
    lambda: { send },
    ...overrides,
  }) as never

describe('queueUrlFromArn', () => {
  it('builds the URL SendMessage needs', () => {
    expect(queueUrlFromArn(QUEUE, 'us-east-1')).toBe('https://sqs.us-east-1.amazonaws.com/111122223333/ingest')
    expect(queueUrlFromArn(`${QUEUE}.fifo`, 'us-east-1')).toBe(
      'https://sqs.us-east-1.amazonaws.com/111122223333/ingest.fifo',
    )
  })

  it('builds the aws-cn host for a China-partition ARN, not amazonaws.com', () => {
    expect(queueUrlFromArn('arn:aws-cn:sqs:cn-north-1:111122223333:ingest', 'cn-north-1')).toBe(
      'https://sqs.cn-north-1.amazonaws.com.cn/111122223333/ingest',
    )
  })

  it('refuses an ARN from another region, because the client is built for one', () => {
    expect(() => queueUrlFromArn(QUEUE, 'eu-west-1')).toThrow('another region')
  })

  it('refuses an ARN with an extra segment rather than silently addressing a different queue', () => {
    expect(() => queueUrlFromArn(`${QUEUE}:extra`, 'us-east-1')).toThrow()
  })

  it('refuses a partition it does not recognise', () => {
    expect(() => queueUrlFromArn('arn:aws-nowhere:sqs:us-east-1:111122223333:ingest', 'us-east-1')).toThrow('partition')
  })

  it('refuses something that is not an ARN at all', () => {
    expect(() => queueUrlFromArn('not-an-arn', 'us-east-1')).toThrow()
  })
})

describe('sendSqs', () => {
  it('sends the payload as the body, with the delivery id and the type as attributes', async () => {
    const send = vi.fn(async (_command: SendMessageCommand) => ({ MessageId: 'm1' }))
    expect(await sendSqs(deps(send), delivery({ channel: 'sqs', queueArn: QUEUE }))).toEqual({ kind: 'delivered' })
    const input = send.mock.calls[0]![0].input
    expect(input.QueueUrl).toBe('https://sqs.us-east-1.amazonaws.com/111122223333/ingest')
    expect(input.MessageBody).toBe('{"id":"dlv_aws","type":"match.final"}')
    expect(input.MessageAttributes!.deliveryId!.StringValue).toBe('dlv_aws')
    expect(input.MessageAttributes!.type!.StringValue).toBe('match.final')
  })

  it('gives a FIFO queue a group and a deduplication id', async () => {
    const send = vi.fn(async (_command: SendMessageCommand) => ({ MessageId: 'm1' }))
    await sendSqs(deps(send, [`${QUEUE}.fifo`]), delivery({ channel: 'sqs', queueArn: `${QUEUE}.fifo` }))
    const input = send.mock.calls[0]![0].input
    expect(input.MessageGroupId).toBe('MATCH#0xabc')
    expect(input.MessageDeduplicationId).toBe('dlv_aws')
  })

  it('refuses an ARN that is not in the allowlist and sends nothing', async () => {
    const send = vi.fn()
    const outcome = await sendSqs(deps(send, []), delivery({ channel: 'sqs', queueArn: QUEUE }))
    expect(outcome).toMatchObject({ kind: 'permanent' })
    expect(outcome.kind === 'permanent' && outcome.error).toContain('not an allowed delivery target')
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a cross-region ARN through the sender itself, without calling AWS or blaming the target', async () => {
    const crossRegion = 'arn:aws:sqs:eu-west-1:111122223333:ingest'
    const send = vi.fn()
    const outcome = await sendSqs(deps(send, [crossRegion]), delivery({ channel: 'sqs', queueArn: crossRegion }))
    expect(outcome).toMatchObject({ kind: 'permanent' })
    expect(outcome.kind === 'permanent' && outcome.error).toContain('another region')
    // proves this goes through the sender, not just the helper: nothing was ever sent
    expect(send).not.toHaveBeenCalled()
  })

  it('has nothing to send with, without a client or a region', async () => {
    const send = vi.fn()
    const noClient = deps(send, undefined, { sqs: undefined })
    expect(await sendSqs(noClient, delivery({ channel: 'sqs', queueArn: QUEUE }))).toEqual({
      kind: 'permanent',
      error: 'no SQS client is configured',
    })
    const noRegion = deps(send, undefined, { region: undefined })
    expect(await sendSqs(noRegion, delivery({ channel: 'sqs', queueArn: QUEUE }))).toEqual({
      kind: 'permanent',
      error: 'no SQS client is configured',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('retries a throttle and does not retry an access denial', async () => {
    const throttled = vi.fn(async () => {
      throw new SQSServiceException({ name: 'RequestThrottled', $fault: 'client', $metadata: {} })
    })
    expect((await sendSqs(deps(throttled), delivery({ channel: 'sqs', queueArn: QUEUE }))).kind).toBe('retry')
    // the shared, unmodeled name every AWS API's auth layer answers a denied policy with
    const denied = vi.fn(async () => {
      throw new SQSServiceException({ name: 'AccessDeniedException', $fault: 'client', $metadata: {} })
    })
    expect((await sendSqs(deps(denied), delivery({ channel: 'sqs', queueArn: QUEUE }))).kind).toBe('permanent')
  })

  it('does not retry the SQS-modeled permanent faults', async () => {
    const cases: [Error, string][] = [
      [new QueueDoesNotExist({ message: 'no such queue', $metadata: {} }), 'QueueDoesNotExist'],
      [new InvalidMessageContents({ message: 'bad characters', $metadata: {} }), 'InvalidMessageContents'],
      [new SqsResourceNotFoundException({ message: 'not found', $metadata: {} }), 'ResourceNotFoundException'],
      [new InvalidAddress({ message: 'bad id', $metadata: {} }), 'InvalidAddress'],
      [new InvalidSecurity({ message: 'not signed', $metadata: {} }), 'InvalidSecurity'],
      [new UnsupportedOperation({ message: 'unsupported', $metadata: {} }), 'UnsupportedOperation'],
      [new KmsAccessDenied({ message: 'kms denied', $metadata: {} }), 'KmsAccessDenied'],
    ]
    for (const [error, name] of cases) {
      const send = vi.fn(async () => {
        throw error
      })
      expect((await sendSqs(deps(send), delivery({ channel: 'sqs', queueArn: QUEUE }))).kind, name).toBe('permanent')
    }
  })
})

describe('sendLambda', () => {
  it('invokes the function with the payload and waits for its answer', async () => {
    const send = vi.fn(async (_command: InvokeCommand) => ({ StatusCode: 200 }))
    expect(await sendLambda(deps(send), delivery({ channel: 'lambda', functionArn: FUNCTION }))).toEqual({
      kind: 'delivered',
      statusCode: 200,
    })
    const input = send.mock.calls[0]![0].input
    expect(input.FunctionName).toBe(FUNCTION)
    expect(input.InvocationType).toBe('RequestResponse')
    expect(Buffer.from(input.Payload as Uint8Array).toString('utf8')).toBe('{"id":"dlv_aws","type":"match.final"}')
  })

  it('retries when the function itself threw', async () => {
    const send = vi.fn(async () => ({
      StatusCode: 200,
      FunctionError: 'Unhandled',
      Payload: new TextEncoder().encode('{"errorMessage":"boom"}'),
    }))
    const outcome = await sendLambda(deps(send), delivery({ channel: 'lambda', functionArn: FUNCTION }))
    expect(outcome).toMatchObject({ kind: 'retry' })
    expect(outcome.kind === 'retry' && outcome.error).toContain('boom')
  })

  it('refuses a function that is not in the allowlist', async () => {
    const send = vi.fn()
    expect((await sendLambda(deps(send, []), delivery({ channel: 'lambda', functionArn: FUNCTION }))).kind).toBe(
      'permanent',
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a function ARN from another region, the mirror of the SQS check, and calls nothing', async () => {
    const crossRegion = 'arn:aws:lambda:eu-west-1:111122223333:function:ingest'
    const send = vi.fn()
    const outcome = await sendLambda(
      deps(send, [crossRegion]),
      delivery({ channel: 'lambda', functionArn: crossRegion }),
    )
    expect(outcome).toMatchObject({ kind: 'permanent' })
    expect(outcome.kind === 'permanent' && outcome.error).toContain('another region')
    expect(send).not.toHaveBeenCalled()
  })

  it('has nothing to invoke with, without a client or a region', async () => {
    const send = vi.fn()
    const noClient = deps(send, undefined, { lambda: undefined })
    expect(await sendLambda(noClient, delivery({ channel: 'lambda', functionArn: FUNCTION }))).toEqual({
      kind: 'permanent',
      error: 'no Lambda client is configured',
    })
    const noRegion = deps(send, undefined, { region: undefined })
    expect(await sendLambda(noRegion, delivery({ channel: 'lambda', functionArn: FUNCTION }))).toEqual({
      kind: 'permanent',
      error: 'no Lambda client is configured',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('does not retry a missing function, a denial, or a bad parameter', async () => {
    const cases: [Error, string][] = [
      [
        new LambdaResourceNotFoundException({ message: 'no such function', $metadata: {} }),
        'ResourceNotFoundException',
      ],
      [
        new LambdaServiceException({
          name: 'AccessDeniedException',
          $fault: 'client',
          message: 'denied',
          $metadata: {},
        }),
        'AccessDeniedException',
      ],
      [
        new InvalidParameterValueException({ message: 'bad parameter', $metadata: {} }),
        'InvalidParameterValueException',
      ],
    ]
    for (const [error, name] of cases) {
      const send = vi.fn(async () => {
        throw error
      })
      expect((await sendLambda(deps(send), delivery({ channel: 'lambda', functionArn: FUNCTION }))).kind, name).toBe(
        'permanent',
      )
    }
  })
})
