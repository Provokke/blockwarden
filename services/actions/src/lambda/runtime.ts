import { Logger } from '@aws-lambda-powertools/logger'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { LambdaClient } from '@aws-sdk/client-lambda'
import { SESv2Client } from '@aws-sdk/client-sesv2'
import { SQSClient } from '@aws-sdk/client-sqs'
import { SSMClient } from '@aws-sdk/client-ssm'
import { createDocumentClient } from '@blockwarden/dynamo'
import { loadConfig, type ActionsConfig } from '../config.js'
import { createLookup, type Lookup } from '../lookup.js'
import { sqsDeliveryQueue, type DeliveryQueue } from '../queue.js'
import { ssmSecrets, type SecretReader } from '../secrets.js'
import { DeliveryStore } from '../store.js'
import { sendEmail } from '../senders/email.js'
import { sendLambda, sendSqs } from '../senders/aws.js'
import { sendRelay } from '../senders/relay.js'
import { sendTelegram } from '../senders/telegram.js'
import { sendWebhook } from '../senders/webhook.js'
import type { Sender } from '../senders/types.js'
import type { DeliveryChannel } from '../records.js'

export type Runtime = {
  config: ActionsConfig
  store: DeliveryStore
  lookup: Lookup
  queue: DeliveryQueue
  deadLetters: DeliveryQueue
  secrets: SecretReader
  senders: Record<DeliveryChannel, Sender>
  ses?: SESv2Client
  sqs: SQSClient
  lambda: LambdaClient
  log: (message: string, data?: Record<string, unknown>, level?: 'warn' | 'error') => void
}

export function createLogger(serviceName: string): Logger {
  return new Logger({ serviceName })
}

export async function createRuntime(logger: Logger): Promise<Runtime> {
  const config = loadConfig(process.env)
  const endpoint = process.env.DYNAMODB_ENDPOINT
  const log = (message: string, data?: Record<string, unknown>, level?: 'warn' | 'error') =>
    logger[level ?? 'info'](message, data ?? {})
  const doc = createDocumentClient(new DynamoDBClient(endpoint ? { endpoint } : {}))
  const sqs = new SQSClient({})
  return {
    config,
    store: new DeliveryStore(doc, config.tableName),
    lookup: createLookup(doc, config.tableName, { log }),
    queue: sqsDeliveryQueue(sqs, config.deliveryQueueUrl),
    deadLetters: sqsDeliveryQueue(sqs, config.deliveryDlqUrl),
    secrets: ssmSecrets(new SSMClient({})),
    senders: {
      webhook: sendWebhook,
      email: sendEmail,
      telegram: sendTelegram,
      relay: sendRelay,
      sqs: sendSqs,
      lambda: sendLambda,
    },
    // built only when a from address exists, so a deployment with no email channel makes no SES client
    ...(config.fromAddress ? { ses: new SESv2Client({}) } : {}),
    sqs,
    lambda: new LambdaClient({}),
    log,
  }
}

export function once<T>(build: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined
  return () => {
    value ??= build().catch((err: unknown) => {
      value = undefined
      throw err
    })
    return value
  }
}
