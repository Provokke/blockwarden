import { randomUUID } from 'node:crypto'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import {
  compileRule,
  RuleValidationError,
  ruleInputSchema,
  type RuleInput,
  type ValidationIssue,
} from '@blockwarden/core'
import { decodeCursor, encodeCursor, error, ok, readJsonBody, type ApiResult } from './http.js'
import type { RuleStore, StoredRule } from './store.js'

export type RuleSettings = { ruleSecretPrefixes: string[]; chainIds: number[] }

export function validateRuleInput(
  value: unknown,
  settings: RuleSettings,
): { ok: true; input: RuleInput } | { ok: false; result: ApiResult } {
  const parsed = ruleInputSchema.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }))
    return { ok: false, result: error(400, 'invalid_rule', 'the rule is not valid', { issues }) }
  }
  const input = parsed.data

  if (!settings.chainIds.includes(input.chainId)) {
    return {
      ok: false,
      result: error(400, 'unknown_chain', `this deployment does not monitor chain ${input.chainId}`),
    }
  }

  let warnings: ValidationIssue[]
  try {
    // the ruleId is not stored yet, and compileRule only uses it to label what it reports
    warnings = compileRule('validate', input).warnings
  } catch (err) {
    if (err instanceof RuleValidationError) {
      return { ok: false, result: error(400, 'invalid_rule', 'the rule does not compile', { issues: err.issues }) }
    }
    throw err
  }
  // a rule written through this route has an author watching, so a warning is refused rather than trimmed -
  // the same choice scripts/put-rule.ts makes. The monitor still tolerates a warning, for rules stored before
  // a check existed
  if (warnings.length > 0) {
    return { ok: false, result: error(400, 'invalid_rule', 'the rule would not do what it says', { issues: warnings }) }
  }

  for (const [index, action] of input.actions.entries()) {
    if (action.type !== 'webhook') continue
    // webhookActionSchema's `url` field already runs checkDestinationUrl inside ruleInputSchema.safeParse
    // above, so an invalid destination never reaches this point - only the prefix check below is live here
    if (action.secretParameter !== undefined && !underPrefix(action.secretParameter, settings.ruleSecretPrefixes)) {
      return {
        ok: false,
        result: error(400, 'secret_not_allowed', 'that parameter is not one this deployment lets a rule name', {
          issues: [{ path: `actions.${index}.secretParameter`, message: 'outside rule_secret_prefixes' }],
        }),
      }
    }
  }

  return { ok: true, input }
}

function underPrefix(name: string, prefixes: string[]): boolean {
  // a prefix names a level of the hierarchy, not a run of characters: /bw/rules must not admit /bw/rulesEvil
  return prefixes.some((prefix) => {
    const base = prefix.endsWith('/') ? prefix : `${prefix}/`
    return name.startsWith(base)
  })
}

const MAX_PAGE = 100

// GSI1's own LastEvaluatedKey for a rules-by-chain query is always exactly these four string attributes, as
// the integration test reads back from DynamoDB Local. The cursor is unsigned base64, so any caller
// can hand back a crafted key; anything of another shape must never reach ExclusiveStartKey, where DynamoDB
// answers a bad key with a ValidationException that has no route-level catch
const RULE_LIST_KEY_ATTRS = ['PK', 'SK', 'GSI1PK', 'GSI1SK'] as const

function isRuleListKey(value: unknown, chainId: number): value is Record<(typeof RULE_LIST_KEY_ATTRS)[number], string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== RULE_LIST_KEY_ATTRS.length) return false
  if (!RULE_LIST_KEY_ATTRS.every((attr) => typeof record[attr] === 'string')) return false
  // shape alone lets a caller mint a cursor naming its own (permitted) chain in the envelope while its key's
  // GSI1PK is another chain's partition (store.ts's putRule: GSI1PK = `CHAIN#<chainId>#RULES`) - that key would
  // still reach ExclusiveStartKey and read that other chain's page, so the partition itself must match too
  return record.GSI1PK === `CHAIN#${chainId}#RULES`
}

export type RuleDeps = { store: RuleStore; settings: RuleSettings; now(): string }

export async function handleListRules(deps: RuleDeps, event: APIGatewayProxyEventV2): Promise<ApiResult> {
  const query = event.queryStringParameters ?? {}
  const chainId = query.chainId === undefined ? undefined : Number(query.chainId)
  if (chainId !== undefined && !deps.settings.chainIds.includes(chainId)) {
    return error(400, 'unknown_chain', 'this deployment does not monitor that chain')
  }
  const limit = pageSize(query.limit)
  const chains = chainId === undefined ? deps.settings.chainIds : [chainId]
  const start = decodeCursor(query.cursor ?? '')
  // the cursor names which chain it stopped on, because a page can end inside any of them
  const startChain = typeof start?.chainId === 'number' ? start.chainId : chains[0]
  // a cursor naming a chain this listing is not walking would send chains.indexOf(startChain) to -1, and
  // chains.slice(-1) would then silently walk only the last chain instead of refusing the request
  if (start !== undefined && !chains.includes(startChain!)) {
    return error(400, 'invalid_cursor', 'the cursor names a chain this listing is not walking')
  }
  const rawKey = start?.key
  if (rawKey !== undefined && !isRuleListKey(rawKey, startChain!)) {
    return error(400, 'invalid_cursor', 'the cursor key is not shaped like one this listing could have issued')
  }
  const startKey = rawKey !== undefined && isRuleListKey(rawKey, startChain!) ? rawKey : undefined

  const rules: StoredRule[] = []
  let cursor: string | undefined
  for (const chain of chains.slice(chains.indexOf(startChain!))) {
    const page = await deps.store.listRules(chain, limit - rules.length, chain === startChain ? startKey : undefined)
    rules.push(...page.rules)
    if (page.cursor) {
      cursor = encodeCursor({ chainId: chain, key: page.cursor })
      break
    }
    if (rules.length >= limit) {
      const next = chains[chains.indexOf(chain) + 1]
      if (next !== undefined) cursor = encodeCursor({ chainId: next })
      break
    }
  }
  return ok({ rules: rules.map(toBody), ...(cursor ? { cursor } : {}) })
}

export async function handleCreateRule(deps: RuleDeps, event: APIGatewayProxyEventV2): Promise<ApiResult> {
  const body = readJsonBody(event)
  if (!body.ok) return body.result
  const validated = validateRuleInput(body.value, deps.settings)
  if (!validated.ok) return validated.result
  const now = deps.now()
  const rule: StoredRule = {
    ruleId: randomUUID(),
    input: validated.input,
    active: true,
    createdAt: now,
    updatedAt: now,
  }
  await deps.store.putRule(rule)
  return { status: 201, body: toBody(rule) }
}

export async function handleGetRule(deps: RuleDeps, event: APIGatewayProxyEventV2): Promise<ApiResult> {
  const rule = await deps.store.getRule(event.pathParameters?.ruleId ?? '')
  if (!rule) return error(404, 'rule_not_found', 'no rule has that id')
  return ok(toBody(rule))
}

export async function handlePatchRule(deps: RuleDeps, event: APIGatewayProxyEventV2): Promise<ApiResult> {
  const ruleId = event.pathParameters?.ruleId ?? ''
  const existing = await deps.store.getRule(ruleId)
  if (!existing) return error(404, 'rule_not_found', 'no rule has that id')
  const body = readJsonBody(event)
  if (!body.ok) return body.result
  const raw = body.value as Record<string, unknown>
  const active = raw.active
  if (active !== undefined && typeof active !== 'boolean') {
    return error(400, 'invalid_rule', 'active must be true or false')
  }
  // a patch carries the whole rule body, because a partial rule cannot be compiled and a rule that does not
  // compile must never reach the table
  const validated = validateRuleInput({ ...raw, active: undefined }, deps.settings)
  if (!validated.ok) return validated.result
  const rule: StoredRule = {
    ruleId,
    input: validated.input,
    active: active ?? existing.active,
    createdAt: existing.createdAt,
    updatedAt: deps.now(),
  }
  await deps.store.putRule(rule)
  return ok(toBody(rule))
}

export async function handleDeleteRule(deps: RuleDeps, event: APIGatewayProxyEventV2): Promise<ApiResult> {
  const deleted = await deps.store.deleteRule(event.pathParameters?.ruleId ?? '')
  if (!deleted) return error(404, 'rule_not_found', 'no rule has that id')
  return { status: 204, body: {} }
}

export function pageSize(raw: string | undefined): number {
  const asked = Number(raw ?? MAX_PAGE)
  if (!Number.isInteger(asked) || asked < 1) return MAX_PAGE
  return Math.min(asked, MAX_PAGE)
}

function toBody(rule: StoredRule) {
  return {
    ruleId: rule.ruleId,
    active: rule.active,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    ...rule.input,
  }
}
