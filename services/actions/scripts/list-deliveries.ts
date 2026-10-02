import { parseArgs } from 'node:util'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { createDocumentClient } from '@blockwarden/dynamo'
import { DeliveryStore } from '../src/store.js'

const { values } = parseArgs({ options: { table: { type: 'string' }, limit: { type: 'string', default: '25' } } })
const tableName = values.table ?? process.env.TABLE_NAME
if (!tableName) {
  console.error('usage: pnpm --filter @blockwarden/actions run delivery:list --table <name> [--limit 25]')
  process.exit(1)
}

const endpoint = process.env.DYNAMODB_ENDPOINT
const store = new DeliveryStore(createDocumentClient(new DynamoDBClient(endpoint ? { endpoint } : {})), tableName)
const dead = await store.listDead(Number(values.limit))
if (dead.length === 0) console.log('no dead deliveries')
for (const delivery of dead) {
  const target = delivery.target.channel === 'webhook' ? delivery.target.url : delivery.channel
  console.log(
    [
      delivery.deliveryId,
      delivery.event,
      delivery.subject,
      target,
      `${delivery.attempts} attempts`,
      delivery.lastStatusCode ?? '-',
      delivery.lastError ?? '-',
    ].join('  '),
  )
}
