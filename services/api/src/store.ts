import { GSI1, GSI2, isConditionFailure, toStorable } from '@blockwarden/dynamo'
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import { ruleInputSchema, type RuleInput } from '@blockwarden/core'

export const NONCE_SECONDS = 300

// `@blockwarden/api` has no dependency on `@blockwarden/actions` (services/* depend on packages/*, not on each
// other), so this is a copied literal of services/actions/src/keys.ts's DUE_SHARDS/dueShard/dueDeliveries, not
// an import of it. A delivery a redrive puts in the wrong shard is one the reaper never sweeps again, so any
// change to that file's shard math must be mirrored here by hand.
const DUE_SHARDS = 4

function dueIndexKeyFor(deliveryId: string): string {
  // the id ends in the hex of a sha256 (services/actions/src/ids.ts's deliveryId), so one digit already
  // spreads evenly over four shards
  const digit = Number.parseInt(deliveryId.slice(-1), 16)
  const shard = Number.isNaN(digit) ? 0 : digit % DUE_SHARDS
  return `DELIVERY#DUE#${shard}`
}

// `@blockwarden/api` has no dependency on `services/relayer` (services/* depend on packages/*, not on each
// other), so these are copied literals of services/relayer/src/keys.ts's `keys.tx`/`keys.pendingTxs`, not an
// import of them. Any change there must be mirrored here by hand.
function txKey(txId: string): { PK: string; SK: string } {
  return { PK: `TX#${txId}`, SK: 'META' }
}

function pendingTxsKey(chainId: number): string {
  return `TXPENDING#${chainId}`
}

// the fixed GSI1 partition infra/terraform/modules/relayer/signers.tf writes onto every signer row so the
// whole small set can be listed with a Query instead of a Scan of this shared table; GSI1SK is the signer id
const SIGNERS_INDEX_KEY = 'SIGNER#ALL'

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

// what the list hands back per row addresses a delivery: its subject (the table's partition key) and its own
// sort key. Neither is the delivery id, which is not itself a lookup key.
export type DeliveryRef = { subject: string; sk: string }

export type DeliveryItem = {
  deliveryId: string
  subject: string
  sk: string
  channel: string
  // the channel's one identifying string - a webhook's raw URL (toRow redacts it), an email address, a chat
  // id, a contract address, a queue or function ARN, or the channel name alone if the shape is not recognised.
  // never the stored target object itself: for a webhook that object also carries secretParameter and
  // caller-supplied headers, neither of which belongs on a listing
  target: string
  status: string
  attempts: number
  createdAt: string
  updatedAt: string
  lastError?: string
  lastStatusCode?: number
  version: number
}

export type DeliveryStore = {
  listDead(
    limit: number,
    cursor?: Record<string, unknown>,
  ): Promise<{ deliveries: DeliveryItem[]; cursor?: Record<string, unknown> }>
  listBySubject(
    subject: string,
    limit: number,
    cursor?: Record<string, unknown>,
  ): Promise<{ deliveries: DeliveryItem[]; cursor?: Record<string, unknown> }>
  getDelivery(ref: DeliveryRef): Promise<DeliveryItem | undefined>
  // takes the row the caller already read (rather than a bare ref) so the handler's one read is the only one:
  // the due shard is computed from the delivery id, which the ref alone does not carry
  requeueDelivery(delivery: DeliveryItem, nowMs: number): Promise<boolean>
}

export type StoredSigner = {
  signerId: string
  chainIds: number[]
  // Terraform never writes this attribute (no keccak256 there) - the relayer derives it from the KMS public
  // key at read time, and this API does not call KMS on a listing. The field is present only for a row that
  // really carries one; a dashboard shows the signer without it rather than guessing
  address?: string
}

export type StoredTx = {
  txId: string
  signerId: string
  chainId: number
  status: string
  createdAt: string
  kind?: string
  from?: string
  to?: string
  data?: string
  // decimal strings, not numbers: the document client reads a number back wrong past 2^53, and both a value
  // and a gas limit can get there on some chains
  value?: string
  gasLimit?: string
  nonce?: number
  hash?: string
  blockNumber?: string
  blockHash?: string
  receiptStatus?: 'success' | 'reverted'
  error?: string
  revertData?: string
  fillerTxId?: string
  idempotencyKey?: string
  reference?: string
  dependsOn?: string
  updatedAt?: string
}

export type RelayerStore = {
  listSigners(): Promise<StoredSigner[]>
  getTx(txId: string): Promise<StoredTx | undefined>
  listPendingTxs(
    chainId: number,
    limit: number,
    cursor?: Record<string, unknown>,
  ): Promise<{ txs: StoredTx[]; cursor?: Record<string, unknown> }>
}

export type ApiStore = NonceStore & ApiKeyStore & RuleStore & MatchStore & DeliveryStore & RelayerStore

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

    async listDead(limit, cursor) {
      const result = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: GSI1,
          KeyConditionExpression: 'GSI1PK = :pk',
          // mirrors services/actions/src/keys.ts's keys.deliveriesByStatus('dead'); GSI1 is sparse and only
          // ever holds a delivery while it is dead, which is what makes this the one status worth an index read
          ExpressionAttributeValues: { ':pk': 'DELIVERY#DEAD' },
          Limit: limit,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      )
      const deliveries: DeliveryItem[] = []
      for (const item of result.Items ?? []) {
        const row = toDeliveryItem(item, log)
        if (row) deliveries.push(row)
      }
      return { deliveries, ...(result.LastEvaluatedKey ? { cursor: result.LastEvaluatedKey } : {}) }
    },

    async listBySubject(subject, limit, cursor) {
      const result = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': subject, ':sk': 'DELIVERY#' },
          Limit: limit,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      )
      const deliveries: DeliveryItem[] = []
      for (const item of result.Items ?? []) {
        const row = toDeliveryItem(item, log)
        if (row) deliveries.push(row)
      }
      return { deliveries, ...(result.LastEvaluatedKey ? { cursor: result.LastEvaluatedKey } : {}) }
    },

    async getDelivery(ref) {
      const result = await doc.send(new GetCommand({ TableName: table, Key: { PK: ref.subject, SK: ref.sk } }))
      return toDeliveryItem(result.Item, log)
    },

    async requeueDelivery(delivery, nowMs) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { PK: delivery.subject, SK: delivery.sk },
            // the row is reset to pending before deliveries.ts's handleRedrive enqueues a message: a pending
            // delivery with a due time is the reaper's to sweep, so a lost enqueue is swept rather than lost.
            // GSI1 is sparse (dead only), so leaving the row is what takes it out of the dead index.
            // lastError, lastStatusCode and firstAttemptAt are removed to match services/actions/src/store.ts's
            // own reset(): a redrive is a new life, and a stale firstAttemptAt would make latency measured
            // from it wrong for ever
            UpdateExpression:
              'SET #status = :pending, attempts = :zero, nextAttemptAt = :now, updatedAt = :updated, ' +
              '#version = #version + :one, GSI2PK = :due, GSI2SK = :now ' +
              'REMOVE GSI1PK, GSI1SK, lastError, lastStatusCode, firstAttemptAt',
            // only a dead delivery may be redriven, and only the one this caller read: a row that changed
            // underneath it loses this condition rather than being redriven a second time
            ConditionExpression: '#status = :dead',
            ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
            ExpressionAttributeValues: {
              ':pending': 'pending',
              ':dead': 'dead',
              ':zero': 0,
              ':one': 1,
              ':now': nowMs,
              ':updated': new Date(nowMs).toISOString(),
              ':due': dueIndexKeyFor(delivery.deliveryId),
            },
          }),
        )
        return true
      } catch (err) {
        if (isConditionFailure(err)) return false
        throw err
      }
    },

    async listSigners() {
      // the signer set is small and operator-configured, but this table also carries every match, delivery
      // and nonce, so even a bounded listing walks the sparse GSI1 index rather than ever scanning the table.
      // Paged fully in a loop (not exposed to the caller) because "every signer" must never truncate silently
      const signers: StoredSigner[] = []
      let startKey: Record<string, unknown> | undefined
      do {
        const result = await doc.send(
          new QueryCommand({
            TableName: table,
            IndexName: GSI1,
            KeyConditionExpression: 'GSI1PK = :pk',
            ExpressionAttributeValues: { ':pk': SIGNERS_INDEX_KEY },
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          }),
        )
        for (const item of result.Items ?? []) {
          const signer = toStoredSigner(item, log)
          if (signer) signers.push(signer)
        }
        startKey = result.LastEvaluatedKey
      } while (startKey)
      return signers
    },

    async getTx(txId) {
      const result = await doc.send(new GetCommand({ TableName: table, Key: txKey(txId) }))
      return toStoredTx(result.Item, log)
    },

    async listPendingTxs(chainId, limit, cursor) {
      const result = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: GSI2,
          KeyConditionExpression: 'GSI2PK = :pk',
          ExpressionAttributeValues: { ':pk': pendingTxsKey(chainId) },
          // GSI2SK is the createdAt epoch millisecond (services/relayer/src/store.ts's txItem), so ascending
          // is oldest first - the transaction an operator most wants to see waiting
          Limit: limit,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      )
      const txs: StoredTx[] = []
      for (const item of result.Items ?? []) {
        const tx = toStoredTx(item, log)
        if (tx) txs.push(tx)
      }
      return { txs, ...(result.LastEvaluatedKey ? { cursor: result.LastEvaluatedKey } : {}) }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The stored target is the channel's own shape (services/actions/src/records.ts's DeliveryTarget union), and
// for a webhook that shape also carries secretParameter and caller-supplied headers. A listing must show only
// the one field that identifies where an action goes - never the object, not even as a fallback, or an
// operator's screen (and the logs) gets more than the route intends. Redacting the webhook URL itself is
// toRow's job (deliveries.ts), so this returns it raw.
function targetString(channel: string, target: unknown): string {
  const record = isRecord(target) ? target : undefined
  switch (channel) {
    case 'webhook':
      return typeof record?.url === 'string' ? record.url : channel
    case 'email':
      return Array.isArray(record?.to)
        ? record.to.filter((to): to is string => typeof to === 'string').join(', ')
        : channel
    case 'telegram':
      return typeof record?.chatId === 'string' ? record.chatId : channel
    case 'relay':
      return typeof record?.to === 'string' ? record.to : channel
    case 'sqs':
      return typeof record?.queueArn === 'string' ? record.queueArn : channel
    case 'lambda':
      return typeof record?.functionArn === 'string' ? record.functionArn : channel
    // a channel this build does not recognise still names itself, never the raw object behind it
    default:
      return channel
  }
}

function toDeliveryItem(
  item: Record<string, unknown> | undefined,
  log: (message: string, data?: Record<string, unknown>, level?: 'warn' | 'error') => void,
): DeliveryItem | undefined {
  if (!item) return undefined
  const deliveryId = item.deliveryId
  const subject = item.subject ?? item.PK
  const sk = item.SK
  const channel = item.channel
  const status = item.status
  if (
    typeof deliveryId !== 'string' ||
    typeof subject !== 'string' ||
    typeof sk !== 'string' ||
    typeof channel !== 'string' ||
    typeof status !== 'string'
  ) {
    // a row that fails to read is invisible through the API from here on - log its id (if it has a readable
    // one) so it can be found and repaired directly, same reasoning as toStoredRule above
    log(
      'skipping a delivery row that cannot be read',
      { deliveryId: typeof deliveryId === 'string' ? deliveryId : undefined },
      'error',
    )
    return undefined
  }
  return {
    deliveryId,
    subject,
    sk,
    channel,
    target: targetString(channel, item.target),
    status,
    attempts: Number(item.attempts ?? 0),
    createdAt: String(item.createdAt ?? ''),
    updatedAt: String(item.updatedAt ?? ''),
    ...(typeof item.lastError === 'string' ? { lastError: item.lastError } : {}),
    ...(typeof item.lastStatusCode === 'number' ? { lastStatusCode: item.lastStatusCode } : {}),
    version: Number(item.version ?? 0),
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

function toStoredSigner(
  item: Record<string, unknown>,
  log: (message: string, data?: Record<string, unknown>, level?: 'warn' | 'error') => void,
): StoredSigner | undefined {
  const signerId = item.signerId
  if (typeof signerId !== 'string' || !Array.isArray(item.chainIds)) {
    log(
      'skipping a signer row that cannot be read',
      { signerId: typeof signerId === 'string' ? signerId : undefined },
      'error',
    )
    return undefined
  }
  return {
    signerId,
    chainIds: item.chainIds.map(Number),
    // present only if the row really carries one - see StoredSigner's own comment; never derived here
    ...(typeof item.address === 'string' ? { address: item.address } : {}),
  }
}

function toStoredTx(
  item: Record<string, unknown> | undefined,
  log: (message: string, data?: Record<string, unknown>, level?: 'warn' | 'error') => void,
): StoredTx | undefined {
  if (!item) return undefined
  const txId = item.txId
  const signerId = item.signerId
  const status = item.status
  if (typeof txId !== 'string' || typeof signerId !== 'string' || typeof status !== 'string') {
    log(
      'skipping a transaction row that cannot be read',
      { txId: typeof txId === 'string' ? txId : undefined },
      'error',
    )
    return undefined
  }
  // mirrors services/relayer/src/records.ts's toTxBody/latestAttempt: the latest signed hash until mined,
  // then the mined hash. Not imported (services/* depend on packages/*, not on each other) - a copied literal
  const mined = isRecord(item.mined) ? item.mined : undefined
  const attempts = Array.isArray(item.attempts) ? item.attempts : []
  const latest = attempts.length > 0 ? attempts[attempts.length - 1] : undefined
  const latestHash = isRecord(latest) && typeof latest.hash === 'string' ? latest.hash : undefined
  const hash = (typeof mined?.hash === 'string' ? mined.hash : undefined) ?? latestHash
  const receiptStatus = mined?.status === 'success' || mined?.status === 'reverted' ? mined.status : undefined
  return {
    txId,
    kind: String(item.kind ?? ''),
    signerId,
    chainId: Number(item.chainId ?? 0),
    from: String(item.from ?? ''),
    to: String(item.to ?? ''),
    data: String(item.data ?? '0x'),
    // written as decimal strings already, but coerced the same defensive way as blockNumber below - a value
    // or gas limit large enough to matter must never round-trip through the document client as a Number
    value: String(item.value ?? '0'),
    gasLimit: String(item.gasLimit ?? '0'),
    status,
    ...(typeof item.nonce === 'number' ? { nonce: item.nonce } : {}),
    ...(hash ? { hash } : {}),
    ...(typeof mined?.blockNumber === 'number' ? { blockNumber: String(mined.blockNumber) } : {}),
    ...(typeof mined?.blockHash === 'string' ? { blockHash: mined.blockHash } : {}),
    ...(receiptStatus ? { receiptStatus } : {}),
    ...(typeof item.error === 'string' ? { error: item.error } : {}),
    ...(typeof item.revertData === 'string' ? { revertData: item.revertData } : {}),
    ...(typeof item.fillerTxId === 'string' ? { fillerTxId: item.fillerTxId } : {}),
    ...(typeof item.idempotencyKey === 'string' ? { idempotencyKey: item.idempotencyKey } : {}),
    ...(typeof item.reference === 'string' ? { reference: item.reference } : {}),
    ...(typeof item.dependsOn === 'string' ? { dependsOn: item.dependsOn } : {}),
    createdAt: String(item.createdAt ?? ''),
    updatedAt: String(item.updatedAt ?? ''),
  }
}
