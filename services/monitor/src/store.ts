import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb'
import type { RuleInput } from '@blockwarden/core'
import { GSI1, GSI2, isConditionFailure, toStorable } from '@blockwarden/dynamo'
import type { Hex } from 'viem'
import { keys } from './keys.js'

export type Cursor = { durableBlock: number; fastBlock: number; version: number }

export type MatchStatus = 'provisional' | 'final' | 'dropped'

export type MatchRecord = {
  matchKey: Hex
  ruleId: string
  chainId: number
  blockNumber: number
  blockHash: Hex
  transactionHash: Hex
  logIndex: number
  ordinal: number
  address: Hex
  args: Record<string, unknown>
  status: MatchStatus
  firstSeenAt: string
  finalizedAt?: string
}

export type NewMatch = Omit<MatchRecord, 'status' | 'finalizedAt'>

export type FinalWrite = 'created' | 'upgraded' | 'unchanged'

export type StoredRule = { ruleId: string; input: RuleInput; active: boolean; createdAt: string; updatedAt: string }

export const MATCH_TTL_SECONDS = 30 * 24 * 60 * 60

export class CursorConflictError extends Error {
  constructor(chainId: number) {
    super(`cursor for chain ${chainId} was changed by another invocation`)
    this.name = 'CursorConflictError'
  }
}

export interface MonitorStorePort {
  acquireLease(chainId: number, owner: string, nowMs: number, ttlMs: number): Promise<boolean>
  releaseLease(chainId: number, owner: string): Promise<void>
  getCursor(chainId: number): Promise<Cursor | undefined>
  saveCursor(chainId: number, next: Cursor): Promise<Cursor>
  listActiveRules(chainId: number): Promise<StoredRule[]>
  writeProvisional(match: NewMatch): Promise<boolean>
  writeFinal(match: NewMatch): Promise<FinalWrite>
  dropStaleProvisional(chainId: number, maxBlockInclusive: number): Promise<number>
}

// picks the stored fields explicitly so a caller's extra properties never reach the item
function matchFields(match: NewMatch) {
  return {
    matchKey: match.matchKey,
    ruleId: match.ruleId,
    chainId: match.chainId,
    blockNumber: match.blockNumber,
    blockHash: match.blockHash,
    transactionHash: match.transactionHash,
    logIndex: match.logIndex,
    ordinal: match.ordinal,
    address: match.address,
    args: toStorable(match.args),
    GSI1PK: keys.matchesByRule(match.ruleId),
    GSI1SK: keys.matchOrder(match.blockNumber, match.logIndex),
  }
}

// a rule that cannot be read is skipped, the same as one that no longer compiles; polling goes on for the rest
function parseInput(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export class MonitorStore implements MonitorStorePort {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly options: { pageSize?: number } = {},
  ) {}

  async acquireLease(chainId: number, owner: string, nowMs: number, ttlMs: number): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          // leaseUntil is milliseconds; expiresAt is the table's TTL attribute in seconds and must not be reused
          Item: { ...keys.lease(chainId), owner, leaseUntil: nowMs + ttlMs },
          ConditionExpression: 'attribute_not_exists(PK) OR leaseUntil < :now',
          ExpressionAttributeValues: { ':now': nowMs },
        }),
      )
      return true
    } catch (err) {
      if (isConditionFailure(err)) return false
      throw err
    }
  }

  async releaseLease(chainId: number, owner: string): Promise<void> {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: keys.lease(chainId),
          ConditionExpression: '#owner = :owner',
          ExpressionAttributeNames: { '#owner': 'owner' },
          ExpressionAttributeValues: { ':owner': owner },
        }),
      )
    } catch (err) {
      if (!isConditionFailure(err)) throw err
    }
  }

  async getCursor(chainId: number): Promise<Cursor | undefined> {
    const { Item } = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: keys.cursor(chainId), ConsistentRead: true }),
    )
    if (!Item) return undefined
    return {
      durableBlock: Item.durableBlock as number,
      fastBlock: Item.fastBlock as number,
      version: Item.version as number,
    }
  }

  async saveCursor(chainId: number, next: Cursor): Promise<Cursor> {
    const saved = { durableBlock: next.durableBlock, fastBlock: next.fastBlock, version: next.version + 1 }
    const guard =
      next.version === 0
        ? { ConditionExpression: 'attribute_not_exists(PK)' }
        : {
            ConditionExpression: '#version = :expected',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':expected': next.version },
          }
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...keys.cursor(chainId), ...saved, updatedAt: this.clock().toISOString() },
          ...guard,
        }),
      )
    } catch (err) {
      if (isConditionFailure(err)) throw new CursorConflictError(chainId)
      throw err
    }
    return saved
  }

  async putRule(rule: StoredRule): Promise<void> {
    const item: Record<string, unknown> = {
      ...keys.rule(rule.ruleId),
      ...rule,
      // a bigint written as a number cannot be read back past 2^53
      input: toStorable(rule.input),
      chainId: rule.input.chainId,
      GSI1SK: keys.ruleOrder(rule.ruleId),
    }
    if (rule.active) item.GSI1PK = keys.activeRules(rule.input.chainId)
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item }))
  }

  async listActiveRules(chainId: number): Promise<StoredRule[]> {
    const items = await this.queryAll({
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': keys.activeRules(chainId) },
    })
    const rules: StoredRule[] = []
    for (const i of items) {
      // Terraform has no way to build a nested DynamoDB map from an arbitrary rule, so a rule it writes keeps
      // its body as one JSON string
      const input = i.input ?? parseInput(i.inputJson)
      if (!input) continue
      rules.push({
        ruleId: i.ruleId as string,
        input: input as RuleInput,
        active: i.active as boolean,
        createdAt: i.createdAt as string,
        updatedAt: i.updatedAt as string,
      })
    }
    return rules
  }

  async writeProvisional(match: NewMatch): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...keys.match(match.matchKey),
            ...matchFields(match),
            status: 'provisional',
            firstSeenAt: match.firstSeenAt,
            GSI2PK: keys.provisionalMatches(match.chainId),
            GSI2SK: match.blockNumber,
            expiresAt: this.expiresAt(),
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      )
      return true
    } catch (err) {
      if (isConditionFailure(err)) return false
      throw err
    }
  }

  async writeFinal(match: NewMatch): Promise<FinalWrite> {
    const fields: Record<string, unknown> = {
      ...matchFields(match),
      status: 'final',
      finalizedAt: this.clock().toISOString(),
      expiresAt: this.expiresAt(),
    }
    const names = Object.fromEntries(Object.keys(fields).map((f) => [`#${f}`, f]))
    const values = Object.fromEntries(Object.entries(fields).map(([f, v]) => [`:${f}`, v]))
    const sets = Object.keys(fields).map((f) => `#${f} = :${f}`)
    try {
      const { Attributes } = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.match(match.matchKey),
          UpdateExpression: `SET ${sets.join(', ')}, #firstSeenAt = if_not_exists(#firstSeenAt, :firstSeenAt) REMOVE GSI2PK, GSI2SK`,
          ConditionExpression: 'attribute_not_exists(PK) OR #status <> :status',
          ExpressionAttributeNames: { ...names, '#firstSeenAt': 'firstSeenAt' },
          ExpressionAttributeValues: { ...values, ':firstSeenAt': match.firstSeenAt },
          ReturnValues: 'ALL_OLD',
        }),
      )
      return Attributes ? 'upgraded' : 'created'
    } catch (err) {
      if (isConditionFailure(err)) return 'unchanged'
      throw err
    }
  }

  async dropStaleProvisional(chainId: number, maxBlockInclusive: number): Promise<number> {
    const stale = await this.queryAll({
      IndexName: GSI2,
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK <= :max',
      ExpressionAttributeValues: { ':pk': keys.provisionalMatches(chainId), ':max': maxBlockInclusive },
    })
    let dropped = 0
    for (const item of stale) {
      try {
        await this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { PK: item.PK, SK: item.SK },
            UpdateExpression: 'SET #status = :dropped REMOVE GSI2PK, GSI2SK',
            // the index is eventually consistent and a durable scan may have made the match final since
            ConditionExpression: '#status = :provisional',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':dropped': 'dropped', ':provisional': 'provisional' },
          }),
        )
        dropped++
      } catch (err) {
        if (!isConditionFailure(err)) throw err
      }
    }
    return dropped
  }

  private expiresAt(): number {
    return Math.floor(this.clock().getTime() / 1000) + MATCH_TTL_SECONDS
  }

  // with a limit, each page asks only for the items still needed, so no read is spent on items thrown away
  private async queryAll(
    input: Omit<QueryCommandInput, 'TableName'>,
    limit?: number,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = []
    let startKey: Record<string, unknown> | undefined
    do {
      const pageLimit =
        limit === undefined ? this.options.pageSize : Math.min(limit - items.length, this.options.pageSize ?? limit)
      const page = await this.doc.send(
        new QueryCommand({
          ...input,
          TableName: this.tableName,
          ...(pageLimit ? { Limit: pageLimit } : {}),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      )
      items.push(...(page.Items ?? []))
      startKey = page.LastEvaluatedKey
    } while (startKey && (limit === undefined || items.length < limit))
    return items
  }
}
