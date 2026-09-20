import { parseArgs } from 'node:util'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { SQSClient } from '@aws-sdk/client-sqs'
import { createDocumentClient } from '@blockwarden/dynamo'
import { refOf } from '../src/keys.js'
import { sqsDeliveryQueue } from '../src/queue.js'
import { DeliveryStore } from '../src/store.js'
import { allDead, checkRedriveArgs, describeTarget } from './lib.js'

const { values } = parseArgs({
  options: {
    table: { type: 'string' },
    queue: { type: 'string' },
    id: { type: 'string' },
    all: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
})
const args = {
  table: values.table ?? process.env.TABLE_NAME,
  queue: values.queue ?? process.env.DELIVERY_QUEUE_URL,
  id: values.id,
  all: values.all,
}
const problem = checkRedriveArgs(args)
if (problem || !args.table || !args.queue) {
  console.error(
    'usage: pnpm --filter @blockwarden/actions run delivery:redrive --table <name> --queue <url> (--id <deliveryId> | --all) [--dry-run]',
  )
  console.error(problem)
  process.exit(1)
}

const endpoint = process.env.DYNAMODB_ENDPOINT
const store = new DeliveryStore(createDocumentClient(new DynamoDBClient(endpoint ? { endpoint } : {})), args.table)
const queue = sqsDeliveryQueue(new SQSClient({}), args.queue)

const dead = await allDead(store)
const chosen = args.all ? dead : dead.filter((d) => d.deliveryId === args.id)
if (chosen.length === 0) {
  console.error(args.all ? 'no dead deliveries' : `no dead delivery with id ${args.id}`)
  process.exit(1)
}
// the count before the writes, so an operator who meant one delivery sees the size of what --all is about to do
console.log(`${chosen.length} dead delivery/deliveries selected of ${dead.length}`)
if (values['dry-run']) {
  for (const delivery of chosen) console.log(`would redrive ${delivery.deliveryId}  ${describeTarget(delivery)}`)
  process.exit(0)
}
for (const delivery of chosen) {
  const reset = await store.reset(delivery, Date.now())
  // the same builder the dispatcher and the reaper use, so a redrive can never point the message at a sort key
  // built some other way
  await queue.send(refOf(reset), 0)
  console.log(`redrove ${reset.deliveryId}`)
}
console.log(`${chosen.length} delivery/deliveries queued again`)
