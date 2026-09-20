import type { InvokeCommand } from '@aws-sdk/client-lambda'
import type { SendMessageCommand } from '@aws-sdk/client-sqs'
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

const deps = (send: unknown, allowed: string[] = [QUEUE, FUNCTION]) =>
  ({
    secrets: { read: async () => ['x'] },
    now: () => 0,
    log: vi.fn(),
    region: 'us-east-1',
    allowedTargetArns: allowed,
    sqs: { send },
    lambda: { send },
  }) as never

describe('queueUrlFromArn', () => {
  it('builds the URL SendMessage needs', () => {
    expect(queueUrlFromArn(QUEUE, 'us-east-1')).toBe('https://sqs.us-east-1.amazonaws.com/111122223333/ingest')
    expect(queueUrlFromArn(`${QUEUE}.fifo`, 'us-east-1')).toBe(
      'https://sqs.us-east-1.amazonaws.com/111122223333/ingest.fifo',
    )
  })

  it('refuses an ARN from another region, because the client is built for one', () => {
    expect(() => queueUrlFromArn(QUEUE, 'eu-west-1')).toThrow('another region')
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

  it('retries a throttle and does not retry an access denial', async () => {
    const throttled = vi.fn(async () => {
      throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
    })
    expect((await sendSqs(deps(throttled), delivery({ channel: 'sqs', queueArn: QUEUE }))).kind).toBe('retry')
    const denied = vi.fn(async () => {
      throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' })
    })
    expect((await sendSqs(deps(denied), delivery({ channel: 'sqs', queueArn: QUEUE }))).kind).toBe('permanent')
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

  it('does not retry a missing function or a denial', async () => {
    for (const name of ['ResourceNotFoundException', 'AccessDeniedException', 'InvalidParameterValueException']) {
      const send = vi.fn(async () => {
        throw Object.assign(new Error(name), { name })
      })
      expect((await sendLambda(deps(send), delivery({ channel: 'lambda', functionArn: FUNCTION }))).kind, name).toBe(
        'permanent',
      )
    }
  })
})
