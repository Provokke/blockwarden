import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import { GSI2, isConditionFailure } from '@blockwarden/dynamo'
import { size, type Address } from 'viem'
import { keys } from './keys.js'
import { MAX_DATA_BYTES, policySchema } from './policy.js'
import { SETTLED, type ApiKeyRecord, type SignerRecord, type TxRecord } from './records.js'

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60
export const SPEND_TTL_SECONDS = 2 * 24 * 60 * 60

export type PauseRecord = { signerId: string; chainId: number; address: Address; requiredWei: string; since: string }

export type CreateResult = { created: true } | { created: false; reason: 'duplicate' | 'spend-cap' }

export type PendingCursor = Record<string, unknown>

export type PendingPage = { txs: TxRecord[]; cursor?: PendingCursor }

export type SpendReservation = { day: string; costGwei: number; capGwei: number }

export class TxConflictError extends Error {
  constructor(txId: string) {
    super(`transaction ${txId} was changed by another invocation`)
    this.name = 'TxConflictError'
  }
}

// thrown once retryingConflicts gives up; a caller can tell this apart from any other failure and ask for a retry
export class StoreBusyError extends Error {
  constructor(what: string, options?: ErrorOptions) {
    super(`${what} kept conflicting with other DynamoDB transactions`, options)
    this.name = 'StoreBusyError'
  }
}

type Cancellation = { CancellationReasons?: { Code?: string }[] }

function cancellationCodes(err: unknown): string[] | undefined {
  if ((err as Error | undefined)?.name !== 'TransactionCanceledException') return undefined
  return ((err as Cancellation).CancellationReasons ?? []).map((r) => r.Code ?? 'None')
}

function failedIndexes(err: unknown): number[] | undefined {
  return cancellationCodes(err)?.flatMap((code, i) => (code === 'ConditionalCheckFailed' ? [i] : []))
}

// Real DynamoDB refuses a write that overlaps a transaction on the same item, writes nothing and does not retry.
// DynamoDB Local never does this.
function isTransactionConflict(err: unknown): boolean {
  if ((err as Error | undefined)?.name === 'TransactionConflictException') return true
  const codes = cancellationCodes(err)
  return !!codes && codes.includes('TransactionConflict') && !codes.includes('ConditionalCheckFailed')
}

const TRANSACTION_CONFLICT_RETRIES = 3

// a counter race is resolved in a handful of rounds; one that goes on this long is a bug or a stampede
const NONCE_ATTEMPTS = 25

async function retryingConflicts(what: string, send: () => Promise<unknown>): Promise<void> {
  for (let retry = 0; ; retry++) {
    try {
      await send()
      return
    } catch (err) {
      if (!isTransactionConflict(err)) throw err
      if (retry >= TRANSACTION_CONFLICT_RETRIES) {
        throw new StoreBusyError(what, { cause: err })
      }
      // full jitter, so the writers that collided do not collide again
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 25 * 2 ** retry))
    }
  }
}

// the item layout of a transaction: GSI2 holds it only while it still has work outstanding
function txItem(tx: TxRecord): Record<string, unknown> {
  const item: Record<string, unknown> = { ...keys.tx(tx.txId), ...tx }
  if (!SETTLED.has(tx.status)) {
    item.GSI2PK = keys.pendingTxs(tx.chainId)
    item.GSI2SK = Date.parse(tx.createdAt)
  }
  return item
}

function fromItem(item: Record<string, unknown>): TxRecord {
  const { PK: _pk, SK: _sk, GSI2PK: _gpk, GSI2SK: _gsk, ...tx } = item
  return tx as TxRecord
}

export class RelayerStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async getSigner(signerId: string): Promise<SignerRecord | undefined> {
    const { Item } = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: keys.signer(signerId) }))
    if (!Item) return undefined
    return {
      signerId: Item.signerId as string,
      keyId: Item.keyId as string,
      chainIds: (Item.chainIds as number[]).map(Number),
      // validated on every read: the item is written by Terraform, outside this code's types
      policy: policySchema.parse(Item.policy),
      ...(Item.webhooks ? { webhooks: Item.webhooks as string[] } : {}),
      ...(Item.webhookSecretParameter ? { webhookSecretParameter: Item.webhookSecretParameter as string } : {}),
    }
  }

  async putSigner(signer: SignerRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: { ...keys.signer(signer.signerId), ...signer } }),
    )
  }

  async getApiKey(hash: string): Promise<ApiKeyRecord | undefined> {
    const { Item } = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: keys.apiKey(hash) }))
    if (!Item) return undefined
    return {
      hash,
      signerIds: Item.signerIds as string[],
      label: Item.label as string,
      ...(Item.createdAt ? { createdAt: Item.createdAt as string } : {}),
    }
  }

  async putApiKey(record: ApiKeyRecord): Promise<void> {
    const { hash, ...rest } = record
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...keys.apiKey(hash), ...rest },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    )
  }

  async getTx(txId: string): Promise<TxRecord | undefined> {
    const { Item } = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: keys.tx(txId), ConsistentRead: true }),
    )
    return Item ? fromItem(Item) : undefined
  }

  async getIdempotency(apiKeyHash: string, key: string): Promise<{ txId: string } | undefined> {
    const { Item } = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: keys.idempotency(apiKeyHash, key), ConsistentRead: true }),
    )
    return Item ? { txId: Item.txId as string } : undefined
  }

  // One transaction writes the tx, claims its idempotency key and reserves the worst-case spend, so a tx is never
  // stored without its reservation and a key never points at a tx that was not stored.
  async createTx(tx: TxRecord, spend: SpendReservation, nowMs: number): Promise<CreateResult> {
    if (!tx.idempotencyKey || !tx.apiKeyHash) throw new Error('a relayed transaction needs an idempotency key')
    // the condition below passes on the first reservation of the day whatever its size, so a cost over the cap stops here
    if (spend.costGwei > spend.capGwei) return { created: false, reason: 'spend-cap' }
    // checkPolicy refuses this first; the store holds the item size limit for any caller that skipped it
    if (size(tx.data) > MAX_DATA_BYTES) throw new Error(`calldata is larger than ${MAX_DATA_BYTES} bytes`)
    const claim = keys.idempotency(tx.apiKeyHash, tx.idempotencyKey)
    try {
      await retryingConflicts(`creating transaction ${tx.txId}`, () =>
        this.doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.tableName,
                  Item: txItem(tx),
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              {
                Put: {
                  TableName: this.tableName,
                  Item: {
                    ...claim,
                    txId: tx.txId,
                    expiresAt: Math.floor(nowMs / 1000) + IDEMPOTENCY_TTL_SECONDS,
                  },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              {
                Update: {
                  TableName: this.tableName,
                  Key: keys.spend(tx.signerId, tx.chainId, spend.day),
                  UpdateExpression: 'ADD spentGwei :cost SET expiresAt = if_not_exists(expiresAt, :expires)',
                  ConditionExpression: 'attribute_not_exists(spentGwei) OR spentGwei <= :room',
                  ExpressionAttributeValues: {
                    ':cost': spend.costGwei,
                    ':room': spend.capGwei - spend.costGwei,
                    ':expires': Math.floor(nowMs / 1000) + SPEND_TTL_SECONDS,
                  },
                },
              },
            ],
          }),
        ),
      )
      return { created: true }
    } catch (err) {
      const failed = failedIndexes(err)
      if (failed?.includes(1)) return { created: false, reason: 'duplicate' }
      if (failed?.includes(2)) return { created: false, reason: 'spend-cap' }
      throw err
    }
  }

  // writes the whole record when the stored version is still the one read; returns the record as saved
  async saveTx(tx: TxRecord, nowIso: string): Promise<TxRecord> {
    const next = { ...tx, version: tx.version + 1, updatedAt: nowIso }
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: txItem(next),
          ConditionExpression: '#version = :version',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':version': tx.version },
        }),
      )
    } catch (err) {
      if (isConditionFailure(err) || isTransactionConflict(err)) throw new TxConflictError(tx.txId)
      throw err
    }
    return next
  }

  // marks the tx failed and creates the filler that takes its nonce, together
  async failWithFiller(
    failed: TxRecord,
    filler: TxRecord,
    nowIso: string,
  ): Promise<{ failed: TxRecord; filler: TxRecord }> {
    const next = { ...failed, version: failed.version + 1, updatedAt: nowIso }
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: txItem(next),
                ConditionExpression: '#version = :version',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':version': failed.version },
              },
            },
            {
              Put: { TableName: this.tableName, Item: txItem(filler), ConditionExpression: 'attribute_not_exists(PK)' },
            },
          ],
        }),
      )
    } catch (err) {
      if (failedIndexes(err)?.length || isTransactionConflict(err)) throw new TxConflictError(failed.txId)
      throw err
    }
    return { failed: next, filler }
  }

  // raises the counter to at least the chain's pending nonce, never lowers it
  async raiseNonce(signerId: string, chainId: number, atLeast: number): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.nonce(signerId, chainId),
          UpdateExpression: 'SET nextNonce = :n',
          ConditionExpression: 'attribute_not_exists(nextNonce) OR nextNonce < :n',
          ExpressionAttributeValues: { ':n': atLeast },
        }),
      )
    } catch (err) {
      if (!isConditionFailure(err)) throw err
    }
  }

  async getNextNonce(signerId: string, chainId: number): Promise<number | undefined> {
    const { Item } = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: keys.nonce(signerId, chainId), ConsistentRead: true }),
    )
    return Item?.nextNonce as number | undefined
  }

  // Takes the next nonce and writes it onto the tx in one transaction, so a crash can never leave a nonce
  // reserved with no tx holding it. A tx that already has a nonce is returned as it is.
  async assignNonce(tx: TxRecord, nowIso: string): Promise<TxRecord> {
    for (let attempt = 0; attempt < NONCE_ATTEMPTS; attempt++) {
      if (tx.nonce !== undefined) return tx
      const current = (await this.getNextNonce(tx.signerId, tx.chainId)) ?? 0
      const next: TxRecord = { ...tx, nonce: current, version: tx.version + 1, updatedAt: nowIso }
      try {
        await retryingConflicts(`assigning a nonce to transaction ${tx.txId}`, () =>
          this.doc.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Update: {
                    TableName: this.tableName,
                    Key: keys.nonce(tx.signerId, tx.chainId),
                    UpdateExpression: 'SET nextNonce = :next',
                    ConditionExpression:
                      current === 0
                        ? 'attribute_not_exists(nextNonce) OR nextNonce = :current'
                        : 'nextNonce = :current',
                    ExpressionAttributeValues: { ':next': current + 1, ':current': current },
                  },
                },
                {
                  Put: {
                    TableName: this.tableName,
                    Item: txItem(next),
                    ConditionExpression: '#version = :version',
                    ExpressionAttributeNames: { '#version': 'version' },
                    ExpressionAttributeValues: { ':version': tx.version },
                  },
                },
              ],
            }),
          ),
        )
        return next
      } catch (err) {
        const failed = failedIndexes(err)
        if (failed?.includes(1)) throw new TxConflictError(tx.txId)
        // the counter moved under us: read it again and retry
        if (failed?.includes(0)) continue
        throw err
      }
    }
    throw new Error(
      `the nonce counter for ${tx.signerId} on chain ${tx.chainId} kept moving; gave up after ${NONCE_ATTEMPTS} attempts`,
    )
  }

  async listPending(chainId: number, limit: number): Promise<TxRecord[]> {
    return (await this.listPendingPage(chainId, limit)).txs
  }

  // one page of the chain's unsettled transactions, oldest first; pass the cursor back to read the next page
  async listPendingPage(chainId: number, limit: number, cursor?: PendingCursor): Promise<PendingPage> {
    const { Items, LastEvaluatedKey } = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI2,
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': keys.pendingTxs(chainId) },
        Limit: limit,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    )
    return { txs: (Items ?? []).map(fromItem), ...(LastEvaluatedKey ? { cursor: LastEvaluatedKey } : {}) }
  }

  async getPause(signerId: string, chainId: number): Promise<PauseRecord | undefined> {
    const { Item } = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: keys.pause(signerId, chainId), ConsistentRead: true }),
    )
    if (!Item) return undefined
    return {
      signerId,
      chainId,
      address: Item.address as Address,
      requiredWei: Item.requiredWei as string,
      since: Item.since as string,
    }
  }

  async pause(record: PauseRecord): Promise<void> {
    const { signerId, chainId, ...rest } = record
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: { ...keys.pause(signerId, chainId), ...rest } }),
    )
  }

  // pauses the signer on the tx's chain until the address holds the value plus the gas limit at this fee
  async pauseForFunds(tx: TxRecord, address: Address, maxFeePerGas: string, since: string): Promise<void> {
    const requiredWei = BigInt(tx.value) + BigInt(tx.gasLimit) * BigInt(maxFeePerGas)
    await this.pause({
      signerId: tx.signerId,
      chainId: tx.chainId,
      address,
      requiredWei: requiredWei.toString(),
      since,
    })
  }

  // deletes only the pause that was read, so a newer pause written since is kept
  async unpause(record: PauseRecord): Promise<boolean> {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: keys.pause(record.signerId, record.chainId),
          ConditionExpression: 'since = :since',
          ExpressionAttributeValues: { ':since': record.since },
        }),
      )
      return true
    } catch (err) {
      if (isConditionFailure(err)) return false
      throw err
    }
  }
}
