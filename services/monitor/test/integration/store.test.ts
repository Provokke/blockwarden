import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ruleInputSchema } from '@blockwarden/core'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import type { Hex } from 'viem'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  CursorConflictError,
  MATCH_TTL_SECONDS,
  MonitorStore,
  type NewMatch,
  type StoredRule,
} from '../../src/store.js'

const EMITTER = '0x5fbdb2315678afecb367f032d93f642f64180aa3'
const NOW = '2026-09-15T00:00:00.000Z'
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

function storedRule(ruleId: string, chainId: number, active: boolean): StoredRule {
  return {
    ruleId,
    active,
    createdAt: NOW,
    updatedAt: NOW,
    input: ruleInputSchema.parse({
      chainId,
      addresses: [EMITTER],
      event: 'event Ping(address indexed from, uint256 value)',
      confirmation: { mode: 'fast' },
    }),
  }
}

function match(id: number, blockNumber: number, overrides: Partial<NewMatch> = {}): NewMatch {
  return {
    matchKey: hash(id),
    ruleId: 'r1',
    chainId: 1,
    blockNumber,
    blockHash: hash(1000 + blockNumber),
    transactionHash: hash(2000 + id),
    logIndex: 0,
    ordinal: 0,
    address: EMITTER,
    args: { value: 10n ** 30n },
    firstSeenAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  }
}

describe('MonitorStore', () => {
  let dynamo: Dynamo
  let store: MonitorStore

  beforeAll(async () => {
    dynamo = await startDynamo()
  })

  afterAll(async () => {
    await dynamo?.stop()
  })

  let tableName: string

  beforeEach(async () => {
    tableName = await dynamo.newTable()
    store = new MonitorStore(dynamo.doc, tableName, () => new Date(NOW))
  })

  async function item(matchKey: Hex) {
    const { Item } = await dynamo.doc.send(
      new GetCommand({ TableName: tableName, Key: { PK: `MATCH#${matchKey}`, SK: 'META' }, ConsistentRead: true }),
    )
    return Item
  }

  function interceptingStore(options: { pageSize?: number; beforeSend?: (command: unknown) => Promise<void> } = {}) {
    const sent: unknown[] = []
    const doc = new Proxy(dynamo.doc, {
      get(target, prop, receiver) {
        if (prop !== 'send') return Reflect.get(target, prop, receiver)
        return async (...args: Parameters<typeof target.send>) => {
          sent.push(args[0])
          await options.beforeSend?.(args[0])
          return target.send(...args)
        }
      },
    })
    return {
      store: new MonitorStore(doc, tableName, () => new Date(NOW), { pageSize: options.pageSize }),
      queries: () => sent.filter((c) => c instanceof QueryCommand).length,
      limits: () => sent.filter((c): c is QueryCommand => c instanceof QueryCommand).map((c) => c.input.Limit),
    }
  }

  it('creates a cursor once and then only with the version it read', async () => {
    expect(await store.getCursor(1)).toBeUndefined()
    const first = await store.saveCursor(1, { durableBlock: 5, fastBlock: 7, version: 0 })
    expect(first).toStrictEqual({ durableBlock: 5, fastBlock: 7, version: 1 })
    await expect(store.saveCursor(1, { ...first, version: 0 })).rejects.toBeInstanceOf(CursorConflictError)

    const second = await store.saveCursor(1, { ...first, durableBlock: 9, fastBlock: 12 })
    expect(second.version).toBe(2)
    await expect(store.saveCursor(1, first)).rejects.toBeInstanceOf(CursorConflictError)
    expect(await store.getCursor(1)).toStrictEqual(second)
  })

  it('grants the chain lease to one owner until it expires or is released', async () => {
    const t0 = 1_000_000
    expect(await store.acquireLease(1, 'a', t0, 90_000)).toBe(true)
    expect(await store.acquireLease(1, 'b', t0 + 1_000, 90_000)).toBe(false)
    expect(await store.acquireLease(1, 'a', t0 + 1_000, 90_000)).toBe(false)
    expect(await store.acquireLease(2, 'b', t0 + 1_000, 90_000)).toBe(true)

    expect(await store.acquireLease(1, 'b', t0 + 90_000, 90_000)).toBe(false)
    expect(await store.acquireLease(1, 'b', t0 + 90_001, 90_000)).toBe(true)

    await store.releaseLease(1, 'a')
    expect(await store.acquireLease(1, 'c', t0 + 90_002, 90_000)).toBe(false)

    await store.releaseLease(1, 'b')
    expect(await store.acquireLease(1, 'c', t0 + 90_003, 90_000)).toBe(true)
    await store.releaseLease(3, 'nobody')

    const { Item } = await dynamo.doc.send(
      new GetCommand({ TableName: tableName, Key: { PK: 'CHAIN#1', SK: 'LEASE' }, ConsistentRead: true }),
    )
    expect(Item).toMatchObject({ owner: 'c', leaseUntil: t0 + 90_003 + 90_000 })
    expect(Item?.expiresAt).toBeUndefined()
    expect(await store.getCursor(1)).toBeUndefined()
  })

  it('lists only active rules for the chain', async () => {
    await store.putRule(storedRule('a', 1, true))
    await store.putRule(storedRule('b', 1, false))
    await store.putRule(storedRule('c', 2, true))
    expect((await store.listActiveRules(1)).map((r) => r.ruleId)).toEqual(['a'])

    await store.putRule(storedRule('a', 1, false))
    expect(await store.listActiveRules(1)).toEqual([])
  })

  it('reads a rule whose body Terraform wrote as a JSON string', async () => {
    const input = {
      chainId: 8453,
      addresses: ['0x1111111111111111111111111111111111111111'],
      event: 'event Transfer(address indexed from, address indexed to, uint256 value)',
      confirmation: { mode: 'finalized' },
      actions: [{ type: 'webhook', url: 'https://example.com/hook' }],
    }
    await dynamo.doc.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: 'RULE#tf-1',
          SK: 'META',
          ruleId: 'tf-1',
          active: true,
          inputJson: JSON.stringify(input),
          chainId: 8453,
          GSI1PK: 'CHAIN#8453#RULES',
          GSI1SK: 'RULE#tf-1',
          createdAt: 'terraform',
          updatedAt: 'terraform',
        },
      }),
    )
    const rules = await store.listActiveRules(8453)
    expect(rules.find((r) => r.ruleId === 'tf-1')?.input).toEqual(input)
  })

  it('skips a rule whose JSON body cannot be parsed, rather than failing the poll', async () => {
    await dynamo.doc.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: 'RULE#tf-2',
          SK: 'META',
          ruleId: 'tf-2',
          active: true,
          inputJson: '{ not json',
          chainId: 8453,
          GSI1PK: 'CHAIN#8453#RULES',
          GSI1SK: 'RULE#tf-2',
          createdAt: 'x',
          updatedAt: 'x',
        },
      }),
    )
    const logged: { message: string; data?: Record<string, unknown> }[] = []
    const logging = new MonitorStore(dynamo.doc, tableName, () => new Date(NOW), {
      log: (message, data) => logged.push({ message, data }),
    })
    const rules = await logging.listActiveRules(8453)
    expect(rules.map((r) => r.ruleId)).not.toContain('tf-2')
    // a rule that silently stops matching leaves nothing to find; the log line is the only trace there is
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data).toEqual({ ruleId: 'tf-2', chainId: 8453 })
  })

  it('writes a provisional match once, indexed by rule and by chain, with bigint args as strings', async () => {
    const m = match(1, 10, { logIndex: 3, ordinal: 2 })
    expect(await store.writeProvisional(m)).toBe(true)
    expect(await store.writeProvisional({ ...m, blockNumber: 11, firstSeenAt: NOW })).toBe(false)

    expect(await item(m.matchKey)).toStrictEqual({
      PK: `MATCH#${m.matchKey}`,
      SK: 'META',
      matchKey: m.matchKey,
      ruleId: 'r1',
      chainId: 1,
      blockNumber: 10,
      blockHash: m.blockHash,
      transactionHash: m.transactionHash,
      logIndex: 3,
      ordinal: 2,
      address: EMITTER,
      args: { value: (10n ** 30n).toString() },
      status: 'provisional',
      firstSeenAt: '2026-09-14T00:00:00.000Z',
      GSI1PK: 'RULE#r1',
      GSI1SK: '000000000010#000003',
      GSI2PK: 'CHAIN#1#PROVISIONAL',
      GSI2SK: 10,
      expiresAt: Math.floor(Date.parse(NOW) / 1000) + MATCH_TTL_SECONDS,
    })
  })

  it('creates a final match outside the provisional index and leaves it unchanged on a rewrite', async () => {
    const m = match(1, 10)
    expect(await store.writeFinal(m)).toBe('created')
    const created = await item(m.matchKey)
    expect(created).toMatchObject({
      status: 'final',
      finalizedAt: NOW,
      firstSeenAt: m.firstSeenAt,
      blockNumber: 10,
      ordinal: 0,
      args: { value: (10n ** 30n).toString() },
      GSI1PK: 'RULE#r1',
      GSI1SK: '000000000010#000000',
      expiresAt: Math.floor(Date.parse(NOW) / 1000) + MATCH_TTL_SECONDS,
    })
    expect(created?.GSI2PK).toBeUndefined()
    expect(created?.GSI2SK).toBeUndefined()

    expect(await store.writeFinal({ ...m, firstSeenAt: NOW })).toBe('unchanged')
    expect(await store.writeProvisional(m)).toBe(false)
    expect(await item(m.matchKey)).toStrictEqual(created)
  })

  it('upgrades a provisional match to final where it was finally seen, keeping firstSeenAt', async () => {
    const m = match(1, 10)
    await store.writeProvisional(m)

    const moved = { ...m, blockNumber: 12, blockHash: hash(77), logIndex: 4, firstSeenAt: NOW }
    expect(await store.writeFinal(moved)).toBe('upgraded')
    const upgraded = await item(m.matchKey)
    expect(upgraded).toMatchObject({
      status: 'final',
      finalizedAt: NOW,
      firstSeenAt: m.firstSeenAt,
      blockNumber: 12,
      blockHash: hash(77),
      logIndex: 4,
      GSI1SK: '000000000012#000004',
    })
    expect(upgraded?.GSI2PK).toBeUndefined()
    expect(upgraded?.GSI2SK).toBeUndefined()
    expect(await store.writeFinal(moved)).toBe('unchanged')
  })

  it('upgrades a dropped match to final', async () => {
    const m = match(1, 10)
    await store.writeProvisional(m)
    expect(await store.dropStaleProvisional(1, 10)).toBe(1)
    expect((await item(m.matchKey))?.status).toBe('dropped')
    expect(await store.writeProvisional(m)).toBe(false)

    expect(await store.writeFinal({ ...m, firstSeenAt: NOW })).toBe('upgraded')
    expect(await item(m.matchKey)).toMatchObject({ status: 'final', firstSeenAt: m.firstSeenAt, finalizedAt: NOW })
  })

  it('drops only provisional matches on the chain at or below the bound', async () => {
    for (const [id, block] of [
      [1, 5],
      [2, 10],
      [3, 11],
      [4, 0],
    ] as const) {
      await store.writeProvisional(match(id, block))
    }
    await store.writeProvisional(match(5, 3, { chainId: 2 }))
    await store.writeFinal(match(6, 4))
    await store.writeProvisional(match(7, 6))
    await store.writeFinal(match(7, 6))
    const finals = [await item(hash(6)), await item(hash(7))]

    expect(await store.dropStaleProvisional(1, 10)).toBe(3)

    const status = async (id: number) => (await item(hash(id)))?.status
    expect(await Promise.all([1, 2, 3, 4, 5].map(status))).toEqual([
      'dropped',
      'dropped',
      'provisional',
      'dropped',
      'provisional',
    ])
    for (const id of [1, 2, 4]) {
      const dropped = await item(hash(id))
      expect(dropped?.GSI2PK).toBeUndefined()
      expect(dropped?.GSI2SK).toBeUndefined()
    }
    expect(await item(hash(3))).toMatchObject({ GSI2PK: 'CHAIN#1#PROVISIONAL', GSI2SK: 11 })
    expect([await item(hash(6)), await item(hash(7))]).toStrictEqual(finals)

    expect(await store.dropStaleProvisional(1, 10)).toBe(0)
    expect(await store.dropStaleProvisional(1, 11)).toBe(1)
    expect(await store.dropStaleProvisional(2, 2)).toBe(0)
    expect(await status(5)).toBe('provisional')
  })

  it('pages through every stale provisional match', async () => {
    for (let id = 1; id <= 30; id++) await store.writeProvisional(match(id, id))
    const paged = interceptingStore({ pageSize: 7 })

    expect(await paged.store.dropStaleProvisional(1, 1000)).toBe(30)
    expect(paged.queries()).toBeGreaterThanOrEqual(5)
    for (let id = 1; id <= 30; id++) expect((await item(hash(id)))?.status).toBe('dropped')
  })

  it('counts only the matches it actually dropped when one becomes final meanwhile', async () => {
    await store.writeProvisional(match(1, 5))
    await store.writeProvisional(match(2, 6))
    let raced = false
    const racing = interceptingStore({
      beforeSend: async (command) => {
        if (raced || !(command instanceof UpdateCommand)) return
        raced = true
        await store.writeFinal(match(1, 5))
        await store.writeFinal(match(2, 6))
      },
    })

    expect(await racing.store.dropStaleProvisional(1, 10)).toBe(0)
    expect((await item(hash(1)))?.status).toBe('final')
    expect((await item(hash(2)))?.status).toBe('final')
  })

  it('asks DynamoDB for no more items than a query limit, across pages', async () => {
    for (let id = 1; id <= 30; id++) await store.writeProvisional(match(id, id))
    const provisional = {
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': 'CHAIN#1#PROVISIONAL' },
    }
    type QueryAll = { queryAll(input: typeof provisional, limit?: number): Promise<Record<string, unknown>[]> }

    const paged = interceptingStore({ pageSize: 7 })
    expect(await (paged.store as unknown as QueryAll).queryAll(provisional, 10)).toHaveLength(10)
    expect(paged.limits()).toEqual([7, 3])

    const unpaged = interceptingStore()
    expect(await (unpaged.store as unknown as QueryAll).queryAll(provisional, 5)).toHaveLength(5)
    expect(unpaged.limits()).toEqual([5])
  })

  it('writes a rule input through toStorable, so a bigint in it is stored as a decimal string', async () => {
    const rule = storedRule('big', 1, true)
    const huge = 10n ** 30n
    const conditions = { field: 'args.value', op: 'gte', value: huge }
    await store.putRule({ ...rule, input: { ...rule.input, conditions } as unknown as StoredRule['input'] })

    const [listed] = await store.listActiveRules(1)
    expect(listed?.input.conditions).toEqual({ ...conditions, value: huge.toString() })
  })
})
