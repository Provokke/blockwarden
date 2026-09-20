import { parseArgs } from 'node:util'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { SQSClient } from '@aws-sdk/client-sqs'
import { createDocumentClient } from '@blockwarden/dynamo'
import { refOf } from '../src/keys.js'
import { sqsDeliveryQueue } from '../src/queue.js'
import { DeliveryStore } from '../src/store.js'

const { values } = parseArgs({
  options: {
    table: { type: 'string' },
    queue: { type: 'string' },
    id: { type: 'string' },
    all: { type: 'boolean', default: false },
  },
})
const tableName = values.table ?? process.env.TABLE_NAME
const queueUrl = values.queue ?? process.env.DELIVERY_QUEUE_URL
if (!tableName || !queueUrl || (!values.id && !values.all)) {
  console.error(
    'usage: pnpm --filter @blockwarden/actions run delivery:redrive --table <name> --queue <url> (--id <deliveryId> | --all)',
  )
  process.exit(1)
}

const endpoint = process.env.DYNAMODB_ENDPOINT
const store = new DeliveryStore(createDocumentClient(new DynamoDBClient(endpoint ? { endpoint } : {})), tableName)
const queue = sqsDeliveryQueue(new SQSClient({}), queueUrl)

// dead deliveries are few, so the list is the index: there is no lookup by delivery id alone
const dead = await store.listDead(500)
const chosen = values.all ? dead : dead.filter((d) => d.deliveryId === values.id)
if (chosen.length === 0) {
  console.error(values.all ? 'no dead deliveries' : `no dead delivery with id ${values.id}`)
  process.exit(1)
}
for (const delivery of chosen) {
  const reset = await store.reset(delivery, Date.now())
  // the same builder the dispatcher and the reaper use, so a redrive can never point the message at a sort key
  // built some other way
  await queue.send(refOf(reset), 0)
  console.log(`redrove ${reset.deliveryId}`)
}
console.log(`${chosen.length} delivery/deliveries queued again`)
