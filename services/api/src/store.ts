import { GSI1, isConditionFailure, toStorable } from '@blockwarden/dynamo'
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { ruleInputSchema, type RuleInput } from '@blockwarden/core'

export const NONCE_SECONDS = 300

export type StoredRule = {
  ruleId: string
  input: RuleInput
  active: boolean
  createdAt: string
  updatedAt: string
}

export type RuleStore = {
  putRule(rule: StoredRule): Promise<void>
  getRule(ruleId: string): Promise<StoredRule | undefined>
  deleteRule(ruleId: string): Promise<boolean>
  listRules(
    chainId: number,
    limit: number,
    cursor?: Record<string, unknown>,
  ): Promise<{ rules: StoredRule[]; cursor?: Record<string, unknown> }>
}

export type NonceStore = {
  put(nonce: string, nowMs: number): Promise<void>
  consume(nonce: string, nowMs: number): Promise<boolean>
}

export type ApiKeyStore = {
  getApiKey(hash: string): Promise<{ hash: string; signerIds: string[]; label: string } | undefined>
}

export type MatchRow = {
  matchKey: string
  ruleId: string
  chainId: number
  blockNumber: string
  blockHash: string
  transactionHash: string
  logIndex: number
  address: string
  args: Record<string, unknown>
  status: 'provisional' | 'final' | 'dropped'
  firstSeenAt: string
  finalizedAt?: string
}

export type MatchStore = {
  listMatches(
    ruleId: string,
    limit: number,
    cursor?: Record<string, unknown>,
    status?: string,
  ): Promise<{ matches: MatchRow[]; cursor?: Record<string, unknown> }>
}

export type ApiStore = NonceStore & ApiKeyStore & RuleStore & MatchStore

export type StoreDeps = {
  doc: DynamoDBDocumentClient
  table: string
  log?: (message: string, data?: Record<string, unknown>, level?: 'warn' | 'error') => void
}

export function createStore(deps: StoreDeps): ApiStore {
  const { doc, table, log = (message, data) => console.error(message, data) } = deps
  return {
    async put(nonce, nowMs) {
      const expiresAt = nowMs + NONCE_SECONDS * 1000
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: { PK: `SIWE#${nonce}`, SK: 'META', expiresAt, ttl: Math.ceil(expiresAt / 1000) },
          // a repeat of a nonce we already issued is a collision, and overwriting one would reset its clock
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      )
    },
    async consume(nonce, nowMs) {
      let deleted
      try {
        const result = await doc.send(
          new DeleteCommand({
            TableName: table,
            Key: { PK: `SIWE#${nonce}`, SK: 'META' },
            ConditionExpression: 'attribute_exists(PK)',
            ReturnValues: 'ALL_OLD',
          }),
        )
        deleted = result.Attributes
      } catch (err) {
        // a second use of the same nonce loses the condition, which is the whole point of single use
        if (isConditionFailure(err)) return false
        throw err
      }
      // TTL is a sweeper, not a clock: DynamoDB deletes up to about 48 hours late, so an item that is still
      // here may be long past its window. The stored time is what decides, and the delete has already run
      const expiresAt = deleted?.expiresAt
      return typeof expiresAt === 'number' && nowMs < expiresAt
    },
    async getApiKey(hash) {
      const result = await doc.send(new GetCommand({ TableName: table, Key: { PK: `APIKEY#${hash}`, SK: 'META' } }))
      const item = result.Item
      if (!item) return undefined
      const label = String(item.label ?? '')
      // Terraform never writes a hash attribute onto the row; the hash the row is keyed by is the hash we
      // looked it up with, same as the relayer's own getApiKey
      if (!Array.isArray(item.signerIds) || item.signerIds.some((id) => typeof id !== 'string')) {
        log('API key row is malformed', { label }, 'error')
        return undefined
      }
      return { hash, signerIds: item.signerIds as string[], label }
    },

    // `@blockwarden/api` has no dependency on `@blockwarden/monitor` (services/* depend on packages/*, not on
    // each other), so the key shapes below are copied literals, not an import of services/monitor/src/keys.ts's
    // `keys.rule`/`keys.ruleOrder`/`keys.activeRules`. Any change there must be mirrored here by hand.
    async putRule(rule) {
      const item: Record<string, unknown> = {
        PK: `RULE#${rule.ruleId}`,
        SK: 'META',
        ...rule,
        // a bigint written as a number cannot be read back past 2^53
        input: toStorable(rule.input),
        chainId: rule.input.chainId,
        GSI1SK: `RULE#${rule.ruleId}`,
      }
      // the index is sparse: an inactive rule leaves it, which is how the monitor stops polling it
      if (rule.active) item.GSI1PK = `CHAIN#${rule.input.chainId}#RULES`
      await doc.send(new PutCommand({ TableName: table, Item: item }))
    },

    async getRule(ruleId) {
      const result = await doc.send(new GetCommand({ TableName: table, Key: { PK: `RULE#${ruleId}`, SK: 'META' } }))
      return toStoredRule(result.Item, log)
    },

    async deleteRule(ruleId) {
      try {
        await doc.send(
          new DeleteCommand({
            TableName: table,
            Key: { PK: `RULE#${ruleId}`, SK: 'META' },
            ConditionExpression: 'attribute_exists(PK)',
          }),
        )
        return true
      } catch (err) {
        if (isConditionFailure(err)) return false
        throw err
      }
    },

    async listRules(chainId, limit, cursor) {
      const result = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: GSI1,
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': `CHAIN#${chainId}#RULES` },
          Limit: limit,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      )
      const rules: StoredRule[] = []
      for (const item of result.Items ?? []) {
        const rule = toStoredRule(item, log)
        if (rule) rules.push(rule)
      }
      return { rules, ...(result.LastEvaluatedKey ? { cursor: result.LastEvaluatedKey } : {}) }
    },

    async listMatches(ruleId, limit, cursor, status) {
      const result = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: GSI1,
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: {
            ':pk': `RULE#${ruleId}`,
            ...(status ? { ':status': status } : {}),
          },
          ...(status
            ? { FilterExpression: '#status = :status', ExpressionAttributeNames: { '#status': 'status' } }
            : {}),
          // GSI1SK is block and log index zero-padded, so descending is newest first with no sort of our own
          ScanIndexForward: false,
          Limit: limit,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      )
      const matches = (result.Items ?? []).map(toMatchRow)
      return { matches, ...(result.LastEvaluatedKey ? { cursor: result.LastEvaluatedKey } : {}) }
    },
  }
}

// a row that cannot be read is skipped, not thrown: one malformed item on a page must not fail its neighbours
// (mirrors services/monitor/src/store.ts's parseInput)
function parseInput(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function toStoredRule(
  item: Record<string, unknown> | undefined,
  log: (message: string, data?: Record<string, unknown>, level?: 'warn' | 'error') => void,
): StoredRule | undefined {
  if (!item) return undefined
  // Terraform has no way to build a nested DynamoDB map from an arbitrary rule, so a rule it writes keeps its
  // body as one JSON string; the monitor reads both shapes and so does this
  const raw = typeof item.inputJson === 'string' ? parseInput(item.inputJson) : item.input
  const parsed = raw === undefined ? undefined : ruleInputSchema.safeParse(raw)
  if (!parsed || !parsed.success) {
    // a row that fails to parse or fails the schema is invisible through the API from here on - log its id
    // (never the body, which can carry a secretParameter name) so it can be found and repaired directly
    log('skipping a rule whose body cannot be read', { ruleId: item.ruleId }, 'error')
    return undefined
  }
  return {
    ruleId: String(item.ruleId),
    input: parsed.data,
    active: item.active === true,
    createdAt: String(item.createdAt ?? ''),
    updatedAt: String(item.updatedAt ?? ''),
  }
}

function toMatchRow(item: Record<string, unknown>): MatchRow {
  return {
    matchKey: String(item.matchKey ?? ''),
    ruleId: String(item.ruleId ?? ''),
    chainId: Number(item.chainId ?? 0),
    // the document client reads a number back wrong past 2^53, and a block number is a chain's clock
    blockNumber: String(item.blockNumber ?? '0'),
    blockHash: String(item.blockHash ?? ''),
    transactionHash: String(item.transactionHash ?? ''),
    logIndex: Number(item.logIndex ?? 0),
    address: String(item.address ?? ''),
    args: (item.args as Record<string, unknown>) ?? {},
    status: item.status as MatchRow['status'],
    firstSeenAt: String(item.firstSeenAt ?? ''),
    ...(item.finalizedAt ? { finalizedAt: String(item.finalizedAt) } : {}),
  }
}
