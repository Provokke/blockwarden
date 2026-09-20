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
