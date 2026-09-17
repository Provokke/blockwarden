import { parseArgs } from 'node:util'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { createDocumentClient } from '@blockwarden/dynamo'
import { createApiKey } from '../src/api-keys.js'
import { RelayerStore } from '../src/store.js'

const { values } = parseArgs({
  options: {
    table: { type: 'string' },
    signer: { type: 'string', multiple: true },
    label: { type: 'string' },
  },
})

const tableName = values.table ?? process.env.TABLE_NAME
if (!tableName || !values.signer?.length || !values.label) {
  console.error(
    'usage: pnpm --filter @blockwarden/relayer run apikey:create --table <name> --signer <signerId> [--signer <signerId>] --label <text>',
  )
  process.exit(1)
}

const endpoint = process.env.DYNAMODB_ENDPOINT
const store = new RelayerStore(createDocumentClient(new DynamoDBClient(endpoint ? { endpoint } : {})), tableName)
const apiKey = await createApiKey(store, { signerIds: values.signer, label: values.label, now: new Date() })
// printed once and never stored in plain text
console.log(apiKey)
