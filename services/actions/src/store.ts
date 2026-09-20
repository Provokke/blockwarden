import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb'
import { GSI1, GSI2, isConditionFailure } from '@blockwarden/dynamo'
import { keys } from './keys.js'
import {
  DELIVERY_TTL_SECONDS,
  MAX_PAYLOAD_BYTES,
  TERMINAL,
  truncate,
  type DeliveryRecord,
  type DeliveryRef,
  type NewDelivery,
} from './records.js'

export class DeliveryConflictError extends Error {
  constructor(deliveryId: string) {
    super(`delivery ${deliveryId} was changed by another invocation`)
    this.name = 'DeliveryConflictError'
  }
}

function item(delivery: DeliveryRecord): Record<string, unknown> {
  const { PK, SK } = keys.delivery(delivery.subject, delivery.actionId, delivery.event, delivery.seq)
  const indexes: Record<string, unknown> = {}
  // sparse: a delivery with nothing outstanding is in neither index, so neither is ever scanned
  if (!TERMINAL.has(delivery.status)) {
    indexes.GSI2PK = keys.dueDeliveries()
    indexes.GSI2SK = delivery.nextAttemptAt ?? 0
  }
  if (delivery.status === 'dead') {
    indexes.GSI1PK = keys.deliveriesByStatus('dead')
    indexes.GSI1SK = `${delivery.createdAt}#${delivery.deliveryId}`
  }
  return { PK, SK, ...delivery, ...indexes }
}

function read(raw: Record<string, unknown>): DeliveryRecord {
  const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, ...rest } = raw
  return rest as DeliveryRecord
}

export class DeliveryStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async create(delivery: NewDelivery, now: Date): Promise<DeliveryRecord | undefined> {
    if (Buffer.byteLength(delivery.payload, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error(`delivery ${delivery.deliveryId} payload is larger than ${MAX_PAYLOAD_BYTES} bytes`)
    }
    const nowMs = now.getTime()
    const record: DeliveryRecord = {
      ...delivery,
      status: 'pending',
      attempts: 0,
      // due immediately, so the reaper picks it up if the message never reaches the queue
      nextAttemptAt: nowMs,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      version: 0,
      expiresAt: Math.floor(nowMs / 1000) + DELIVERY_TTL_SECONDS,
    }
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item(record),
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      )
    } catch (err) {
      // a stream record delivered twice, which is ordinary
      if (isConditionFailure(err)) return undefined
      throw err
    }
    return record
  }

  async get(ref: DeliveryRef): Promise<DeliveryRecord | undefined> {
    const { Item } = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: ref.subject, SK: ref.sk }, ConsistentRead: true }),
    )
    return Item ? read(Item) : undefined
  }

  markQueued(delivery: DeliveryRecord, nowMs: number): Promise<DeliveryRecord> {
    return this.save({ ...delivery, status: 'queued' }, nowMs)
  }

  // the claim is the lease: nextAttemptAt moves out by the lease, so the reaper leaves an attempt in flight alone
  claim(delivery: DeliveryRecord, nowMs: number, leaseMs: number): Promise<DeliveryRecord> {
    return this.save(
      {
        ...delivery,
        status: 'delivering',
        attempts: delivery.attempts + 1,
        firstAttemptAt: delivery.firstAttemptAt ?? nowMs,
        lastAttemptAt: nowMs,
        nextAttemptAt: nowMs + leaseMs,
      },
      nowMs,
    )
  }

  markDelivered(delivery: DeliveryRecord, nowMs: number, statusCode?: number): Promise<DeliveryRecord> {
    const { nextAttemptAt: _dropped, lastError: _cleared, ...rest } = delivery
    return this.save({ ...rest, status: 'delivered', ...codeOf(statusCode) }, nowMs)
  }

  scheduleRetry(
    delivery: DeliveryRecord,
    nowMs: number,
    nextAttemptAt: number,
    error: string,
    statusCode?: number,
  ): Promise<DeliveryRecord> {
    return this.save(
      { ...delivery, status: 'failed', nextAttemptAt, lastError: truncate(error), ...codeOf(statusCode) },
      nowMs,
    )
  }

  markDead(delivery: DeliveryRecord, nowMs: number, error: string, statusCode?: number): Promise<DeliveryRecord> {
    const { nextAttemptAt: _dropped, ...rest } = delivery
    return this.save({ ...rest, status: 'dead', lastError: truncate(error), ...codeOf(statusCode) }, nowMs)
  }

  reset(delivery: DeliveryRecord, nowMs: number): Promise<DeliveryRecord> {
    const { lastError: _cleared, lastStatusCode: _code, ...rest } = delivery
    return this.save({ ...rest, status: 'pending', attempts: 0, nextAttemptAt: nowMs }, nowMs)
  }

  async listDue(nowMs: number, limit: number): Promise<DeliveryRecord[]> {
    return this.query(
      {
        IndexName: GSI2,
        KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK <= :now',
        ExpressionAttributeValues: { ':pk': keys.dueDeliveries(), ':now': nowMs },
      },
      limit,
    )
  }

  async listDead(limit: number): Promise<DeliveryRecord[]> {
    return this.query(
      {
        IndexName: GSI1,
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': keys.deliveriesByStatus('dead') },
      },
      limit,
    )
  }

  private async save(next: DeliveryRecord, nowMs: number): Promise<DeliveryRecord> {
    const saved = { ...next, version: next.version + 1, updatedAt: new Date(nowMs).toISOString() }
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item(saved),
          ConditionExpression: '#version = :version',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':version': next.version },
        }),
      )
    } catch (err) {
      if (isConditionFailure(err)) throw new DeliveryConflictError(next.deliveryId)
      throw err
    }
    return saved
  }

  private async query(input: Omit<QueryCommandInput, 'TableName'>, limit: number): Promise<DeliveryRecord[]> {
    const page = await this.doc.send(new QueryCommand({ ...input, TableName: this.tableName, Limit: limit }))
    return (page.Items ?? []).map(read)
  }
}

function codeOf(statusCode?: number): { lastStatusCode?: number } {
  return statusCode === undefined ? {} : { lastStatusCode: statusCode }
}
