import { parseArgs } from 'node:util'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { createDocumentClient } from '@blockwarden/dynamo'
import { DeliveryStore } from '../src/store.js'
import { describeTarget, positiveInt } from './lib.js'

const { values } = parseArgs({ options: { table: { type: 'string' }, limit: { type: 'string', default: '25' } } })
const tableName = values.table ?? process.env.TABLE_NAME
const limit = positiveInt(values.limit)
if (!tableName || limit === undefined) {
  console.error('usage: pnpm --filter @blockwarden/actions run delivery:list --table <name> [--limit 25]')
  if (tableName) console.error('--limit must be a whole number of at least 1')
  process.exit(1)
}

const endpoint = process.env.DYNAMODB_ENDPOINT
const store = new DeliveryStore(createDocumentClient(new DynamoDBClient(endpoint ? { endpoint } : {})), tableName)
const dead = await store.listDead(limit)
if (dead.length === 0) console.log('no dead deliveries')
for (const delivery of dead) {
  console.log(
    [
      delivery.deliveryId,
      delivery.event,
      delivery.subject,
      describeTarget(delivery),
      `${delivery.attempts} attempts`,
      delivery.lastStatusCode ?? '-',
      delivery.lastError ?? '-',
    ].join('  '),
  )
}
