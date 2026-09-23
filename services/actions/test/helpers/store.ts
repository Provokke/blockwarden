import { GenericContainer, Wait } from 'testcontainers'
import { SESv2Client } from '@aws-sdk/client-sesv2'
import { SQSClient } from '@aws-sdk/client-sqs'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { keys } from '../../src/keys.js'
import type { NewDelivery } from '../../src/records.js'
import { deliveryId } from '../../src/ids.js'
import { DeliveryStore } from '../../src/store.js'

export type Harness = { dynamo: Dynamo; store: DeliveryStore; tableName: string }

export async function startStore(dynamo: Dynamo): Promise<Harness> {
  const tableName = await dynamo.newTable()
  return { dynamo, store: new DeliveryStore(dynamo.doc, tableName), tableName }
}

export { startDynamo }

// one webhook delivery for a match, with every field a store test needs
export function newDelivery(overrides: Partial<NewDelivery> = {}): NewDelivery {
  const subject = overrides.subject ?? keys.matchSubject('0xabc')
  const actionId = overrides.actionId ?? 'a_00112233aabbccdd'
  const event = overrides.event ?? 'match.final'
  const seq = overrides.seq ?? 0
  const { SK } = keys.delivery(subject, actionId, event, seq)
  return {
    deliveryId: deliveryId(subject, SK),
    subject,
    actionId,
    event,
    seq,
    channel: 'webhook',
    target: { channel: 'webhook', url: 'https://example.com/hook' },
    payload: '{"id":"x"}',
    ...overrides,
  }
}

// moto 5.2.3 serves SES v2 and SQS; its KMS is unusable, which the relayer's own helper works around
export async function startMoto() {
  const container = await new GenericContainer('motoserver/moto:5.2.3')
    .withExposedPorts(5000)
    .withWaitStrategy(Wait.forHttp('/', 5000))
    .start()
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(5000)}`
  const config = { endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
  const ses = new SESv2Client(config)
  const sqs = new SQSClient(config)
  return {
    endpoint,
    ses,
    sqs,
    // moto keeps every backend's state here; ses.Message holds what SendEmail was given
    async sentEmails(): Promise<
      { id: string; source: string; subject: string; body: string; destinations: Record<string, string[]> }[]
    > {
      const response = await fetch(`${endpoint}/moto-api/data.json`)
      const data = (await response.json()) as { ses?: { Message?: unknown[] } }
      return (data.ses?.Message ?? []) as never
    },
    async stop(): Promise<void> {
      ses.destroy()
      sqs.destroy()
      await container.stop()
    },
  }
}
