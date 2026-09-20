import { createServer, type Server } from 'node:http'
import { LambdaClient } from '@aws-sdk/client-lambda'
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sendLambda, sendSqs } from '../../src/senders/aws.js'
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

const FUNCTION = 'arn:aws:lambda:us-east-1:111122223333:function:ingest'

// moto has no working Lambda invoke (it needs Docker to actually run a function's code), so this plays the
// real Invoke REST endpoint instead: POST /2015-03-31/functions/<name>/invocations, answered with whatever
// this test wants. What matters is that a real LambdaClient - not a hand-typed fake - sends and parses it.
async function serveLambda(
  answer: (body: string) => { status: number; headers?: Record<string, string>; body: string },
): Promise<{ endpoint: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const { status, headers, body } = answer(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(status, headers)
      res.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the Lambda test server did not bind a port')
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      }),
  }
}

const lambdaDelivery = (): DeliveryRecord => ({
  deliveryId: 'dlv_lambda',
  subject: 'MATCH#0xabc',
  actionId: 'a_1111111111111111',
  event: 'match.final',
  seq: 0,
  channel: 'lambda',
  target: { channel: 'lambda', functionArn: FUNCTION },
  payload: '{"id":"dlv_lambda"}',
  status: 'delivering',
  attempts: 1,
  createdAt: 'now',
  updatedAt: 'now',
  version: 1,
  expiresAt: 0,
})

describe('sendLambda against a real client', () => {
  it('invokes the function over the wire and reads the answer back', async () => {
    let receivedBody = ''
    const server = await serveLambda((body) => {
      receivedBody = body
      return { status: 200, body: '{"ok":true}' }
    })
    try {
      // a real LambdaClient, typed exactly as SenderDeps expects it - not a fake standing in for its shape
      const lambda = new LambdaClient({
        endpoint: server.endpoint,
        region: 'us-east-1',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      })
      const deps = {
        secrets: { read: async () => ['x'] },
        now: () => 0,
        log: () => {},
        region: 'us-east-1',
        allowedTargetArns: [FUNCTION],
        lambda,
      } as never
      expect(await sendLambda(deps, lambdaDelivery())).toEqual({ kind: 'delivered', statusCode: 200 })
      expect(receivedBody).toBe('{"id":"dlv_lambda"}')
    } finally {
      await server.close()
    }
  })

  it('retries when the function answers with a function error header', async () => {
    const server = await serveLambda(() => ({
      status: 200,
      headers: { 'x-amz-function-error': 'Unhandled' },
      body: '{"errorMessage":"boom"}',
    }))
    try {
      const lambda = new LambdaClient({
        endpoint: server.endpoint,
        region: 'us-east-1',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      })
      const deps = {
        secrets: { read: async () => ['x'] },
        now: () => 0,
        log: () => {},
        region: 'us-east-1',
        allowedTargetArns: [FUNCTION],
        lambda,
      } as never
      const outcome = await sendLambda(deps, lambdaDelivery())
      expect(outcome).toMatchObject({ kind: 'retry' })
      expect(outcome.kind === 'retry' && outcome.error).toContain('boom')
    } finally {
      await server.close()
    }
  })
})
