import { isConditionFailure } from '@blockwarden/dynamo'
import { DeleteCommand, GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

export const NONCE_SECONDS = 300

export type NonceStore = {
  put(nonce: string, nowMs: number): Promise<void>
  consume(nonce: string, nowMs: number): Promise<boolean>
}

export type ApiKeyStore = {
  getApiKey(hash: string): Promise<{ hash: string; signerIds: string[]; label: string } | undefined>
}

export type ApiStore = NonceStore & ApiKeyStore

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
  }
}
