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

export type ApiStore = NonceStore & ApiKeyStore & RuleStore

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
      return toStoredRule(result.Item)
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
        const rule = toStoredRule(item)
        if (rule) rules.push(rule)
      }
      return { rules, ...(result.LastEvaluatedKey ? { cursor: result.LastEvaluatedKey } : {}) }
    },
  }
}

function toStoredRule(item: Record<string, unknown> | undefined): StoredRule | undefined {
  if (!item) return undefined
  // Terraform has no way to build a nested DynamoDB map from an arbitrary rule, so a rule it writes keeps its
  // body as one JSON string; the monitor reads both shapes and so does this
  const raw = typeof item.inputJson === 'string' ? JSON.parse(item.inputJson) : item.input
  const parsed = ruleInputSchema.safeParse(raw)
  if (!parsed.success) return undefined
  return {
    ruleId: String(item.ruleId),
    input: parsed.data,
    active: item.active === true,
    createdAt: String(item.createdAt ?? ''),
    updatedAt: String(item.updatedAt ?? ''),
  }
}
