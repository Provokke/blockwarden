import { type DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { GSI1, GSI2, isConditionFailure } from '@blockwarden/dynamo'
import { DUE_SHARDS, keys } from './keys.js'
import {
  DELIVERY_TTL_SECONDS,
  MAX_PAYLOAD_BYTES,
  TERMINAL,
  truncate,
  type DeliveryRecord,
  type DeliveryRef,
  type NewDelivery,
} from './records.js'

// The reaper leaves a delivery alone until its due time is this far past, so a sweep never races a message
// already on the queue: it asks for what was due a grace ago.
export const REAPER_GRACE_MS = 60_000

// one page of the due index, and where the next page starts: one start key per shard
export type DueCursor = Record<string, Record<string, unknown>>

export type DuePage = { deliveries: DeliveryRecord[]; cursor?: DueCursor }

export type DeadCursor = Record<string, unknown>

export type DeadPage = { deliveries: DeliveryRecord[]; cursor?: DeadCursor }

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
    indexes.GSI2PK = keys.dueDeliveries(keys.dueShard(delivery.deliveryId))
    indexes.GSI2SK = delivery.nextAttemptAt ?? 0
  }
  if (delivery.status === 'dead') {
    indexes.GSI1PK = keys.deliveriesByStatus('dead')
    indexes.GSI1SK = `${delivery.createdAt}#${delivery.deliveryId}`
  }
  return { PK, SK, ...delivery, ...indexes }
}

// what a GSI query needs to carry on where it stopped: the table's own key and the index's
function startKey(raw: Record<string, unknown>): Record<string, unknown> {
  return { PK: raw.PK, SK: raw.SK, GSI2PK: raw.GSI2PK, GSI2SK: raw.GSI2SK }
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

  // queuing moves the due time out by the reaper's grace, or every sweep would queue this delivery again and
  // the version-conditioned claim would throw all but one of the messages away
  markQueued(delivery: DeliveryRecord, nowMs: number): Promise<DeliveryRecord> {
    return this.save({ ...delivery, status: 'queued', nextAttemptAt: nowMs + REAPER_GRACE_MS }, nowMs)
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

  // a redrive is a new life: the old first attempt would make any latency measured on it wrong for ever
  reset(delivery: DeliveryRecord, nowMs: number): Promise<DeliveryRecord> {
    const { lastError: _cleared, lastStatusCode: _code, firstAttemptAt: _first, ...rest } = delivery
    return this.save({ ...rest, status: 'pending', attempts: 0, nextAttemptAt: nowMs }, nowMs)
  }

  async listDue(nowMs: number, limit: number): Promise<DeliveryRecord[]> {
    return (await this.listDuePage(nowMs, limit)).deliveries
  }

  // One page of the deliveries due by nowMs, oldest first; pass the cursor back for the next one, or a backlog
  // longer than the limit hands back the same oldest page for ever and hides everything behind it.
  async listDuePage(nowMs: number, limit: number, cursor?: DueCursor): Promise<DuePage> {
    const shards = await Promise.all(
      Array.from({ length: DUE_SHARDS }, async (_, shard) => {
        const from = cursor?.[shard]
        const page = await this.doc.send(
          new QueryCommand({
            TableName: this.tableName,
            IndexName: GSI2,
            KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK <= :now',
            ExpressionAttributeValues: { ':pk': keys.dueDeliveries(shard), ':now': nowMs },
            Limit: limit,
            ...(from ? { ExclusiveStartKey: from } : {}),
          }),
        )
        return { shard, from, items: page.Items ?? [], more: page.LastEvaluatedKey !== undefined }
      }),
    )
    // each shard comes back oldest first, so merging on the due time is what makes the whole index oldest first
    const merged = shards
      .flatMap(({ shard, items }) => items.map((item) => ({ shard, item })))
      .sort((a, b) => Number(a.item.GSI2SK) - Number(b.item.GSI2SK))
    const page = merged.slice(0, limit)
    const next: DueCursor = {}
    for (const { shard, from } of shards) {
      const taken = page.filter((entry) => entry.shard === shard)
      const last = taken[taken.length - 1]
      if (last) next[shard] = startKey(last.item)
      // nothing of this shard made the page, so the next one starts it exactly where this one did; dropping the
      // start key here would send an exhausted shard back to its oldest item and read it all again
      else if (from) next[shard] = from
    }
    const drained = page.length === merged.length && shards.every(({ more }) => !more)
    return { deliveries: page.map(({ item }) => read(item)), ...(drained ? {} : { cursor: next }) }
  }

  async listDead(limit: number): Promise<DeliveryRecord[]> {
    return (await this.listDeadPage(limit)).deliveries
  }

  // one page of the dead letters, oldest first; the redrive script walks the whole list with the cursor
  async listDeadPage(limit: number, cursor?: DeadCursor): Promise<DeadPage> {
    const { Items, LastEvaluatedKey } = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI1,
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': keys.deliveriesByStatus('dead') },
        Limit: limit,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    )
    return { deliveries: (Items ?? []).map(read), ...(LastEvaluatedKey ? { cursor: LastEvaluatedKey } : {}) }
  }

  // Nothing writes a delivery item inside a DynamoDB transaction, so a raw TransactionConflictException cannot
  // reach a caller and the version condition below is the only failure to map. A transactional writer on these
  // items would need the relayer's retry treatment here too.
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
}

function codeOf(statusCode?: number): { lastStatusCode?: number } {
  return statusCode === undefined ? {} : { lastStatusCode: statusCode }
}
