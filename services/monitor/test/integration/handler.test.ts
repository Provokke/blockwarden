import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ruleInputSchema } from '@blockwarden/core'
import type { Hex } from 'viem'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createChainReader } from '../../src/chain.js'
import { keys } from '../../src/keys.js'
import { MonitorStore, type StoredRule } from '../../src/store.js'
import { GSI1 } from '../../src/table.js'
import { PING_EVENT, startAnvil, type Anvil } from '../helpers/anvil.js'
import { startDynamo, type Dynamo } from '../helpers/dynamo.js'

describe('monitor handler end to end', () => {
  let anvil: Anvil
  let dynamo: Dynamo
  let tableName: string
  let emitter: Hex
  let handler: typeof import('../../src/handler.js').handler
  const dynamoEndpointBefore = process.env.DYNAMODB_ENDPOINT

  const records = async (ruleId: string) => {
    const { Items } = await dynamo.doc.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: GSI1,
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': keys.matchesByRule(ruleId) },
      }),
    )
    return (Items ?? []).map((item) => ({
      status: item.status as string,
      value: (item.args as { value: string }).value,
      blockNumber: item.blockNumber as number,
    }))
  }

  beforeAll(async () => {
    ;[anvil, dynamo] = await Promise.all([startAnvil(), startDynamo()])
    tableName = await dynamo.newTable()
    const store = new MonitorStore(dynamo.doc, tableName)
    emitter = await anvil.deployEmitter()
    const start = await createChainReader([anvil.rpcUrl]).getHead()

    const rule = (ruleId: string, mode: 'fast' | 'finalized'): StoredRule => ({
      ruleId,
      active: true,
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      input: ruleInputSchema.parse({
        chainId: anvil.chainId,
        addresses: [emitter],
        event: PING_EVENT,
        conditions: { field: 'args.value', op: 'gte', value: '10' },
        confirmation: { mode },
      }),
    })
    await store.putRule(rule('fast', 'fast'))
    await store.putRule(rule('final', 'finalized'))

    vi.stubEnv('TABLE_NAME', tableName)
    vi.stubEnv('CHAIN_ID', String(anvil.chainId))
    vi.stubEnv('RPC_URLS', anvil.rpcUrl)
    vi.stubEnv('START_BLOCK', String(start))
    vi.stubEnv('DYNAMODB_ENDPOINT', dynamo.endpoint)
    vi.stubEnv('AWS_REGION', 'us-east-1')
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'local')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'local')
    vi.resetModules()
    ;({ handler } = await import('../../src/handler.js'))
  })

  afterAll(async () => {
    try {
      vi.unstubAllEnvs()
      expect(process.env.DYNAMODB_ENDPOINT).toBe(dynamoEndpointBefore)
    } finally {
      await Promise.all([anvil?.stop(), dynamo?.stop()])
    }
  })

  it('alerts a fast rule provisionally and ignores small values', async () => {
    await anvil.ping(emitter, 42n)
    await anvil.ping(emitter, 5n)

    const result = await handler(undefined)

    expect(result).toMatchObject({ status: 'ok', provisional: 1, final: 0 })
    expect(await records('fast')).toMatchObject([{ status: 'provisional', value: '42' }])
    expect(await records('final')).toEqual([])
  })

  it('finalizes both rules once the block is finalized', async () => {
    // Anvil reports finalized as head minus 64.
    await anvil.mine(64)

    const result = await handler(undefined)

    expect(result).toMatchObject({ status: 'ok', final: 2 })
    expect(await records('fast')).toMatchObject([{ status: 'final', value: '42' }])
    expect(await records('final')).toMatchObject([{ status: 'final', value: '42' }])
  })

  it('drops a provisional alert whose block was reorganised away', async () => {
    const { blockNumber } = await anvil.ping(emitter, 50n)
    expect((await handler(undefined)).provisional).toBe(1)

    // anvil_reorg with no transactions removes the ping for good; it is never re-mined.
    await anvil.reorg(1)
    await anvil.mine(64 + 64 + 1)

    const result = await handler(undefined)

    expect(result).toMatchObject({ status: 'ok', dropped: 1 })
    expect((await records('fast')).find((r) => r.blockNumber === blockNumber)).toMatchObject({
      status: 'dropped',
      value: '50',
    })
    expect((await records('final')).map((r) => r.value)).toEqual(['42'])
  })
})
