import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { compileRule, RuleValidationError, ruleInputSchema } from '@blockwarden/core'
import { createDocumentClient } from '@blockwarden/dynamo'
import { MonitorStore } from '../src/store.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    table: { type: 'string' },
    id: { type: 'string' },
    inactive: { type: 'boolean', default: false },
  },
})

const file = positionals[0]
const tableName = values.table ?? process.env.TABLE_NAME
if (!file || !tableName) {
  console.error(
    'usage: pnpm --filter @blockwarden/monitor run rule:put <rule.json> --table <name> [--id <ruleId>] [--inactive]',
  )
  process.exit(1)
}

const input = ruleInputSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
const ruleId = values.id ?? randomUUID()
// compileRule only throws over what stops a rule matching; everything else it drops and reports as a warning,
// so that a rule written before a check existed keeps being polled. A rule being written now has an author
// watching, so this path refuses the lot.
const compiled = compileRule(ruleId, input)
if (compiled.warnings.length > 0) throw new RuleValidationError(compiled.warnings)

const endpoint = process.env.DYNAMODB_ENDPOINT
const store = new MonitorStore(createDocumentClient(new DynamoDBClient(endpoint ? { endpoint } : {})), tableName)
const now = new Date().toISOString()
await store.putRule({ ruleId, input, active: !values.inactive, createdAt: now, updatedAt: now })
console.log(`stored rule ${ruleId} for chain ${input.chainId}`)
