import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MonitorStore } from '../../../monitor/src/store.js'
import { handleListMatches } from '../../src/matches.js'
import { createStore, type ApiStore } from '../../src/store.js'

let dynamo: Dynamo
let store: ApiStore
let monitor: MonitorStore

beforeAll(async () => {
  dynamo = await startDynamo()
  const table = await dynamo.newTable()
  store = createStore({ doc: dynamo.doc, table })
  monitor = new MonitorStore(dynamo.doc, table)

  for (let block = 1; block <= 5; block++) {
    await monitor.writeFinal({
      matchKey: `0x${block.toString(16).padStart(64, '0')}`,
      ruleId: 'rule-a',
      chainId: 8453,
      blockNumber: block,
      blockHash: `0x${'b'.repeat(64)}`,
      transactionHash: `0x${'c'.repeat(64)}`,
      logIndex: 0,
      ordinal: 0,
      address: `0x${'d'.repeat(40)}`,
      args: { value: '1' },
      firstSeenAt: '2026-09-21T00:00:00.000Z',
    })
  }
}, 180_000)

afterAll(async () => {
  await dynamo?.stop()
})

// narrowed to the real event type rather than to `never`, same helper as rules-store.test.ts's apiEvent
function apiEvent(over: Partial<APIGatewayProxyEventV2>): APIGatewayProxyEventV2 {
  return { version: '2.0', headers: {}, ...over } as APIGatewayProxyEventV2
}

function event(query: Record<string, string>) {
  return apiEvent({ routeKey: 'GET /v1/matches', queryStringParameters: query })
}

describe('match history against a real table', () => {
  it('returns newest first', async () => {
    const result = await handleListMatches({ store }, event({ ruleId: 'rule-a' }))
    const body = result.body as { matches: { blockNumber: string }[] }
    expect(body.matches.map((m) => m.blockNumber)).toEqual(['5', '4', '3', '2', '1'])
  })

  it('pages with a cursor that resumes exactly where the page stopped', async () => {
    const first = await handleListMatches({ store }, event({ ruleId: 'rule-a', limit: '2' }))
    const firstBody = first.body as { matches: { blockNumber: string }[]; cursor: string }
    expect(firstBody.matches.map((m) => m.blockNumber)).toEqual(['5', '4'])

    const second = await handleListMatches({ store }, event({ ruleId: 'rule-a', limit: '2', cursor: firstBody.cursor }))
    const secondBody = second.body as { matches: { blockNumber: string }[] }
    expect(secondBody.matches.map((m) => m.blockNumber)).toEqual(['3', '2'])
  })

  it('returns nothing for a rule with no matches, rather than failing', async () => {
    const result = await handleListMatches({ store }, event({ ruleId: 'rule-with-none' }))
    expect((result.body as { matches: unknown[] }).matches).toEqual([])
  })

  it('refuses a cursor built for another rule before DynamoDB sees it', async () => {
    const first = await handleListMatches({ store }, event({ ruleId: 'rule-a', limit: '2' }))
    const { cursor } = first.body as { cursor: string }
    const result = await handleListMatches({ store }, event({ ruleId: 'rule-with-none', cursor }))
    expect(result.status).toBe(400)
  })

  it('a status filter can come back short of the page even though more rows exist, because Limit runs before FilterExpression', async () => {
    // rule-a has 5 final matches; asking for a limit larger than the whole rule but filtered to a status
    // with zero matches still walks the index in pages, so the first read comes back empty with a cursor
    // rather than the handler quietly padding the page out from a second read
    const result = await handleListMatches({ store }, event({ ruleId: 'rule-a', limit: '3', status: 'provisional' }))
    const body = result.body as { matches: unknown[]; cursor?: string }
    expect(body.matches).toEqual([])
    expect(body.cursor).toBeDefined()
  })
})
