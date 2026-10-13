import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { describe, expect, it } from 'vitest'
import { encodeCursor } from '../../src/http.js'
import { handleListMatches, type MatchDeps } from '../../src/matches.js'
import type { MatchRow } from '../../src/store.js'

// narrowed to the real event type rather than to `never`, same helper as rules.test.ts and rules-store.test.ts
function apiEvent(over: Partial<APIGatewayProxyEventV2>): APIGatewayProxyEventV2 {
  return { version: '2.0', headers: {}, ...over } as APIGatewayProxyEventV2
}

function row(ruleId: string, blockNumber: number): MatchRow {
  return {
    matchKey: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    ruleId,
    chainId: 8453,
    blockNumber: String(blockNumber),
    blockHash: `0x${'b'.repeat(64)}`,
    transactionHash: `0x${'c'.repeat(64)}`,
    logIndex: 0,
    address: `0x${'d'.repeat(40)}`,
    args: { value: '1' },
    status: 'final',
    firstSeenAt: '2026-09-21T00:00:00.000Z',
  }
}

// a page key shaped like the one the real store actually returns (see matches.ts's MATCH_LIST_KEY_ATTRS),
// so this fake exercises the same cursor shape-check the real store's key would have to pass
function pageKey(ruleId: string, blockNumber: number): Record<string, string> {
  const order = String(blockNumber).padStart(12, '0') + '#000000'
  return {
    PK: `MATCH#0x${blockNumber.toString(16).padStart(64, '0')}`,
    SK: 'META',
    GSI1PK: `RULE#${ruleId}`,
    GSI1SK: order,
  }
}

function deps(): MatchDeps & { calls: unknown[] } {
  const rows = [row('rule-a', 3), row('rule-a', 2), row('rule-a', 1), row('rule-b', 9)]
  const calls: unknown[] = []
  return {
    calls,
    store: {
      async listMatches(ruleId, limit, cursor) {
        calls.push({ ruleId, limit, cursor })
        const mine = rows.filter((r) => r.ruleId === ruleId)
        const from = mine.findIndex((r) => cursor && pageKey(r.ruleId, Number(r.blockNumber)).GSI1SK === cursor.GSI1SK)
        const start = cursor === undefined ? 0 : from + 1
        const page = mine.slice(start, start + limit)
        const last = page[page.length - 1]
        const next = start + limit < mine.length && last ? pageKey(last.ruleId, Number(last.blockNumber)) : undefined
        return { matches: page, ...(next ? { cursor: next } : {}) }
      },
    },
  }
}

function event(query: Record<string, string>) {
  return apiEvent({ routeKey: 'GET /v1/matches', queryStringParameters: query })
}

describe('handleListMatches', () => {
  it('requires a ruleId, because the index is per rule', async () => {
    const result = await handleListMatches(deps(), event({}))
    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe('rule_required')
  })

  it('returns a rule matches newest first', async () => {
    const result = await handleListMatches(deps(), event({ ruleId: 'rule-a' }))
    const body = result.body as { matches: MatchRow[] }
    expect(body.matches.map((m) => m.blockNumber)).toEqual(['3', '2', '1'])
  })

  it('caps the page size and passes the cap down, rather than trimming after the read', async () => {
    const d = deps()
    await handleListMatches(d, event({ ruleId: 'rule-a', limit: '5000' }))
    expect((d.calls[0] as { limit: number }).limit).toBe(100)
  })

  it('ignores a limit that is not a positive integer', async () => {
    const d = deps()
    for (const limit of ['0', '-3', 'many', '1.5']) {
      d.calls.length = 0
      await handleListMatches(d, event({ ruleId: 'rule-a', limit }))
      expect((d.calls[0] as { limit: number }).limit).toBe(100)
    }
  })

  it('hands back a cursor and resumes from it', async () => {
    const d = deps()
    const first = await handleListMatches(d, event({ ruleId: 'rule-a', limit: '2' }))
    const firstBody = first.body as { matches: MatchRow[]; cursor?: string }
    expect(firstBody.matches).toHaveLength(2)
    expect(firstBody.cursor).toBeDefined()

    const second = await handleListMatches(d, event({ ruleId: 'rule-a', limit: '2', cursor: firstBody.cursor! }))
    const secondBody = second.body as { matches: MatchRow[] }
    expect(secondBody.matches.map((m) => m.blockNumber)).toEqual(['1'])
  })

  it('refuses a cursor minted for another rule', async () => {
    const forged = encodeCursor({ ruleId: 'rule-b', key: pageKey('rule-b', 9) })
    const result = await handleListMatches(deps(), event({ ruleId: 'rule-a', cursor: forged }))
    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe('invalid_cursor')
  })

  it('refuses a cursor that is not a cursor, rather than passing it to DynamoDB', async () => {
    const d = deps()
    const result = await handleListMatches(d, event({ ruleId: 'rule-a', cursor: 'garbage' }))
    expect(result.status).toBe(400)
    expect(d.calls).toHaveLength(0)
  })

  it('refuses a cursor whose key is not shaped like a real page key, instead of forwarding it to DynamoDB', async () => {
    const d = deps()
    for (const key of [
      { GSI1SK: '000000000003#000000' },
      { ...pageKey('rule-a', 3), extra: 'nope' },
      'not-an-object',
    ]) {
      const cursor = encodeCursor({ ruleId: 'rule-a', key })
      const result = await handleListMatches(d, event({ ruleId: 'rule-a', cursor }))
      expect(result.status, JSON.stringify(key)).toBe(400)
      expect((result.body as { error: { code: string } }).error.code, JSON.stringify(key)).toBe('invalid_cursor')
    }
  })

  it('filters by status when one is asked for, and refuses one that is not a status', async () => {
    const ok = await handleListMatches(deps(), event({ ruleId: 'rule-a', status: 'final' }))
    expect(ok.status).toBe(200)
    const bad = await handleListMatches(deps(), event({ ruleId: 'rule-a', status: 'sideways' }))
    expect(bad.status).toBe(400)
  })

  it('returns block numbers as strings, because a chain outlives 2^53', async () => {
    const result = await handleListMatches(deps(), event({ ruleId: 'rule-a' }))
    for (const match of (result.body as { matches: MatchRow[] }).matches) {
      expect(typeof match.blockNumber).toBe('string')
    }
  })
})
