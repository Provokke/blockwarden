import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sendSqs } from '../../src/senders/aws.js'
import type { DeliveryRecord } from '../../src/records.js'
import { startMoto } from '../helpers/store.js'

let moto: Awaited<ReturnType<typeof startMoto>>
let queueUrl: string
let queueArn: string

beforeAll(async () => {
  moto = await startMoto()
  const created = await moto.sqs.send(new CreateQueueCommand({ QueueName: 'ingest' }))
  queueUrl = created.QueueUrl!
  const attributes = await moto.sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  )
  queueArn = attributes.Attributes!.QueueArn!
}, 180_000)

afterAll(async () => {
  await moto.stop()
})

describe('sendSqs against a real queue', () => {
  it('puts the payload on the queue with its attributes', async () => {
    const delivery: DeliveryRecord = {
      deliveryId: 'dlv_sqs',
      subject: 'MATCH#0xabc',
      actionId: 'a_1111111111111111',
      event: 'match.final',
      seq: 0,
      channel: 'sqs',
      target: { channel: 'sqs', queueArn },
      payload: '{"id":"dlv_sqs"}',
      status: 'delivering',
      attempts: 1,
      createdAt: 'now',
      updatedAt: 'now',
      version: 1,
      expiresAt: 0,
    }
    // moto's queue URL is not the public sqs.<region>.amazonaws.com form, so the client is pointed at it directly
    const deps = {
      secrets: { read: async () => ['x'] },
      now: () => 0,
      log: () => {},
      region: 'us-east-1',
      allowedTargetArns: [queueArn],
      // spreading the command would drop its prototype methods (resolveMiddleware lives there, not on the
      // instance), so the URL is swapped in place on the same command moto's client expects
      sqs: {
        send: (command: { input: { QueueUrl?: string } }) => {
          command.input.QueueUrl = queueUrl
          return moto.sqs.send(command as never)
        },
      },
    } as never
    expect(await sendSqs(deps, delivery)).toEqual({ kind: 'delivered' })
    const { Messages } = await moto.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, MessageAttributeNames: ['All'] }),
    )
    expect(Messages![0]!.Body).toBe('{"id":"dlv_sqs"}')
    expect(Messages![0]!.MessageAttributes!.deliveryId!.StringValue).toBe('dlv_sqs')
  })
})
