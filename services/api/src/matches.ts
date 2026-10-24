import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { decodeCursor, encodeCursor, error, ok, type ApiResult } from './http.js'
import type { MatchRow, MatchStore } from './store.js'

const MAX_PAGE = 100
const STATUSES = new Set(['provisional', 'final', 'dropped'])

// GSI1's own LastEvaluatedKey for a matches-by-rule query is always exactly these four string attributes, as
// the integration test reads back from DynamoDB Local. The cursor is unsigned base64, so any caller can hand
// back a crafted key; anything of another shape must never reach ExclusiveStartKey, where DynamoDB answers a
// bad key with a ValidationException that has no route-level catch
const MATCH_LIST_KEY_ATTRS = ['PK', 'SK', 'GSI1PK', 'GSI1SK'] as const

function isMatchListKey(
  value: unknown,
  ruleId: string,
): value is Record<(typeof MATCH_LIST_KEY_ATTRS)[number], string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== MATCH_LIST_KEY_ATTRS.length) return false
  if (!MATCH_LIST_KEY_ATTRS.every((attr) => typeof record[attr] === 'string')) return false
  // DynamoDB reads the partition the KeyConditionExpression names and rejects a start key from any other
  // partition with a ValidationException, so a key for another rule's partition must not reach it
  return record.GSI1PK === `RULE#${ruleId}`
}

export type MatchDeps = { store: MatchStore }

export async function handleListMatches(deps: MatchDeps, event: APIGatewayProxyEventV2): Promise<ApiResult> {
  const query = event.queryStringParameters ?? {}
  const ruleId = query.ruleId
  // GSI1 is partitioned by rule, so there is no index that answers "every match" - saying so beats a scan
  if (!ruleId) return error(400, 'rule_required', 'ruleId is required')

  const status = query.status
  if (status !== undefined && !STATUSES.has(status)) {
    return error(400, 'invalid_status', 'status must be provisional, final or dropped')
  }

  let startKey: Record<string, unknown> | undefined
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor)
    // a cursor is an ExclusiveStartKey, which is a row address; one minted for another rule would read that
    // rule's matches, so the cursor carries the rule it was made for and has to agree
    if (!cursor || cursor.ruleId !== ruleId || !isMatchListKey(cursor.key, ruleId)) {
      return error(400, 'invalid_cursor', 'that cursor does not belong to this query')
    }
    startKey = cursor.key
  }

  const page = await deps.store.listMatches(ruleId, pageSize(query.limit), startKey, status)
  return ok({
    matches: page.matches,
    ...(page.cursor ? { cursor: encodeCursor({ ruleId, key: page.cursor }) } : {}),
  })
}

function pageSize(raw: string | undefined): number {
  const asked = Number(raw ?? MAX_PAGE)
  if (!Number.isInteger(asked) || asked < 1) return MAX_PAGE
  return Math.min(asked, MAX_PAGE)
}

export type { MatchRow }
