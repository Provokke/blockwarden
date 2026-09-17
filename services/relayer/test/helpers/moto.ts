import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs'
import type { SQSBatchResponse, SQSRecord } from 'aws-lambda'
import { GenericContainer, Wait } from 'testcontainers'

export type Moto = Awaited<ReturnType<typeof startMoto>>

// moto 5.2.3 keeps SQS FIFO ordering, deduplication and group blocking (measured 2026-09-15). Its KMS signs a
// hash of the digest instead of the digest, so it is used for SQS only.
export async function startMoto() {
  const container = await new GenericContainer('motoserver/moto:5.2.3')
    .withExposedPorts(5000)
    .withWaitStrategy(Wait.forHttp('/', 5000))
    .start()
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(5000)}`
  const sqs = new SQSClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  })
  let queues = 0

  return {
    sqs,
    async newFifoQueue(): Promise<string> {
      const { QueueUrl } = await sqs.send(
        new CreateQueueCommand({
          QueueName: `relayer-test-${++queues}.fifo`,
          Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '30' },
        }),
      )
      return QueueUrl!
    },
    // plays the Lambda event source mapping: receive, hand the batch over, delete what succeeded
    async drain(queueUrl: string, handle: (records: SQSRecord[]) => Promise<SQSBatchResponse>): Promise<string[]> {
      const bodies: string[] = []
      for (;;) {
        const { Messages = [] } = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 0,
            MessageSystemAttributeNames: ['MessageGroupId'],
          }),
        )
        if (Messages.length === 0) return bodies
        const { batchItemFailures } = await handle(Messages.map(toRecord))
        const failed = new Set(batchItemFailures.map((f) => f.itemIdentifier))
        if (failed.size > 0) throw new Error(`messages failed: ${[...failed].join(', ')}`)
        for (const message of Messages) {
          bodies.push(message.Body!)
          await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }))
        }
      }
    },
    async stop(): Promise<void> {
      sqs.destroy()
      await container.stop()
    },
  }
}

function toRecord(message: Message): SQSRecord {
  return {
    messageId: message.MessageId!,
    receiptHandle: message.ReceiptHandle!,
    body: message.Body!,
    attributes: { MessageGroupId: message.Attributes?.MessageGroupId } as SQSRecord['attributes'],
    messageAttributes: {},
    md5OfBody: message.MD5OfBody!,
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:relayer-test.fifo',
    awsRegion: 'us-east-1',
  }
}
