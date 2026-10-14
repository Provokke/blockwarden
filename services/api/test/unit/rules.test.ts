import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import type { RuleInput } from '@blockwarden/core'
import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from '../../src/http.js'
import { handleListRules, pageSize, validateRuleInput, type RuleDeps, type RuleSettings } from '../../src/rules.js'
import type { RuleStore, StoredRule } from '../../src/store.js'

// narrowed to the real event type rather than to `never`, same helper as the integration test's apiEvent
function apiEvent(over: Partial<APIGatewayProxyEventV2>): APIGatewayProxyEventV2 {
  return { version: '2.0', headers: {}, ...over } as APIGatewayProxyEventV2
}

const settings: RuleSettings = { ruleSecretPrefixes: ['/bw/rules/'], chainIds: [8453, 42161] }

function rule(over: Record<string, unknown> = {}) {
  return {
    chainId: 8453,
    addresses: ['0x4200000000000000000000000000000000000006'],
    event: 'event Transfer(address indexed from, address indexed to, uint256 value)',
    confirmation: { mode: 'finalized' },
    actions: [{ type: 'webhook', url: 'https://example.com/hook' }],
    ...over,
  }
}

describe('validateRuleInput', () => {
  it('accepts a rule the monitor would compile', () => {
    const outcome = validateRuleInput(rule(), settings)
    expect(outcome.ok).toBe(true)
  })

  it('refuses a chain the deployment does not monitor', () => {
    const outcome = validateRuleInput(rule({ chainId: 1 }), settings)
    expect(outcome).toMatchObject({ ok: false })
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.result.status).toBe(400)
    expect((outcome.result.body as { error: { code: string } }).error.code).toBe('unknown_chain')
  })

  it('refuses an event signature that will not parse, with the compiler own message', () => {
    const outcome = validateRuleInput(rule({ event: 'not an event' }), settings)
    if (outcome.ok) throw new Error('unreachable')
    const body = outcome.result.body as { error: { code: string; issues?: { path: string }[] } }
    expect(body.error.code).toBe('invalid_rule')
    expect(body.error.issues?.[0]?.path).toBe('event')
  })

  it('refuses a condition on a field the event does not have', () => {
    const outcome = validateRuleInput(
      rule({ conditions: { all: [{ field: 'args.nosuch', op: 'eq', value: '1' }] } }),
      settings,
    )
    if (outcome.ok) throw new Error('unreachable')
    expect((outcome.result.body as { error: { code: string } }).error.code).toBe('invalid_rule')
  })

  it('refuses a rule that only warns, because its author is watching', () => {
    // an indexed tuple's inner field can never be read back from a log; compileRule warns rather than throws
    const outcome = validateRuleInput(
      rule({
        event: 'event Granted(address indexed owner, (address spender, uint256 cap) indexed permission)',
        conditions: { all: [{ field: 'args.permission.spender', op: 'eq', value: '0x00' }] },
      }),
      settings,
    )
    if (outcome.ok) throw new Error('unreachable')
    const body = outcome.result.body as { error: { code: string; issues?: unknown[] } }
    expect(body.error.code).toBe('invalid_rule')
    expect(body.error.issues?.length).toBeGreaterThan(0)
  })

  it('refuses an http webhook URL', () => {
    const outcome = validateRuleInput(
      rule({ actions: [{ type: 'webhook', url: 'http://example.com/hook' }] }),
      settings,
    )
    if (outcome.ok) throw new Error('unreachable')
    expect((outcome.result.body as { error: { code: string } }).error.code).toBe('invalid_rule')
  })

  it('refuses a webhook URL pointing at a private address', () => {
    for (const url of [
      'https://127.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://2130706433/hook',
      'https://[::1]/hook',
    ]) {
      const outcome = validateRuleInput(rule({ actions: [{ type: 'webhook', url }] }), settings)
      expect(outcome.ok, url).toBe(false)
    }
  })

  it('refuses a webhook URL carrying a password', () => {
    const outcome = validateRuleInput(
      rule({ actions: [{ type: 'webhook', url: 'https://user:pw@example.com/hook' }] }),
      settings,
    )
    expect(outcome.ok).toBe(false)
  })

  it('refuses a secretParameter outside the deployment prefixes', () => {
    const outcome = validateRuleInput(
      rule({
        actions: [{ type: 'webhook', url: 'https://example.com/hook', secretParameter: '/other/party/secret' }],
      }),
      settings,
    )
    if (outcome.ok) throw new Error('unreachable')
    expect((outcome.result.body as { error: { code: string } }).error.code).toBe('secret_not_allowed')
  })

  it('accepts a secretParameter inside them', () => {
    const outcome = validateRuleInput(
      rule({
        actions: [{ type: 'webhook', url: 'https://example.com/hook', secretParameter: '/bw/rules/mine' }],
      }),
      settings,
    )
    expect(outcome.ok).toBe(true)
  })

  it('refuses a prefix match that is not a level of the hierarchy', () => {
    const outcome = validateRuleInput(
      rule({
        actions: [{ type: 'webhook', url: 'https://example.com/hook', secretParameter: '/bw/rulesEvil/mine' }],
      }),
      { ...settings, ruleSecretPrefixes: ['/bw/rules'] },
    )
    expect(outcome.ok).toBe(false)
  })

  it('refuses more than five actions, as the schema does', () => {
    const actions = Array.from({ length: 6 }, () => ({ type: 'webhook', url: 'https://example.com/hook' }))
    expect(validateRuleInput(rule({ actions }), settings).ok).toBe(false)
  })

  it('refuses a body that is not an object', () => {
    for (const bad of [null, 42, 'rule', []]) expect(validateRuleInput(bad, settings).ok).toBe(false)
  })
})

describe('pageSize', () => {
  it('passes through a limit inside the cap', () => {
    expect(pageSize('7')).toBe(7)
  })

  it('clamps a limit above the cap to the cap', () => {
    expect(pageSize('500')).toBe(100)
  })

  it('falls back to the cap for a limit that is not a positive integer', () => {
    for (const raw of [undefined, '0', '-1', '1.5', 'abc', '']) expect(pageSize(raw), JSON.stringify(raw)).toBe(100)
  })
})

// a fake in full control of each chain's page, to force the one case real DynamoDB pagination rarely lines up
// on by itself: a chain whose remaining rows exactly fill the page, with no cursor of its own. Both chainId
// and limit are read and used to slice each chain's fixture, not ignored.
function fakeRuleStore(pages: Record<number, StoredRule[]>): RuleStore {
  return {
    async putRule() {
      throw new Error('not exercised by this test')
    },
    async getRule() {
      return undefined
    },
    async deleteRule() {
      return false
    },
    async listRules(chainId, limit) {
      return { rules: (pages[chainId] ?? []).slice(0, limit) }
    },
  }
}

function fixtureRule(ruleId: string, chainId: number): StoredRule {
  const input: RuleInput = {
    chainId,
    addresses: ['0x4200000000000000000000000000000000000006'],
    event: 'event Transfer(address indexed from, address indexed to, uint256 value)',
    confirmation: { mode: 'finalized' },
    actions: [],
  }
  return { ruleId, input, active: true, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' }
}

describe('handleListRules across a chain boundary', () => {
  it('continues into the next chain when one ends exactly at the page limit, with no duplicate and no missing row', async () => {
    const store = fakeRuleStore({
      8453: [fixtureRule('a1', 8453), fixtureRule('a2', 8453)],
      42161: [fixtureRule('b1', 42161)],
    })
    const deps: RuleDeps = {
      store,
      settings: { ruleSecretPrefixes: [], chainIds: [8453, 42161] },
      now: () => '2026-09-21T00:00:00.000Z',
    }
    const list = (query: Record<string, string>) =>
      handleListRules(deps, apiEvent({ routeKey: 'GET /v1/rules', queryStringParameters: query }))

    const first = await list({ limit: '2' })
    const firstBody = first.body as { rules: { ruleId: string }[]; cursor?: string }
    expect(firstBody.rules.map((r) => r.ruleId)).toEqual(['a1', 'a2'])
    expect(firstBody.cursor).toBeDefined()
    expect(decodeCursor(firstBody.cursor!)).toMatchObject({ chainId: 42161 })

    const second = await list({ limit: '2', cursor: firstBody.cursor! })
    const secondBody = second.body as { rules: { ruleId: string }[]; cursor?: string }
    expect(secondBody.rules.map((r) => r.ruleId)).toEqual(['b1'])
    expect(secondBody.cursor).toBeUndefined()
  })

  it('refuses a cursor whose key names a different chains partition than the one it claims to resume', async () => {
    const store = fakeRuleStore({ 8453: [fixtureRule('a1', 8453)], 42161: [fixtureRule('b1', 42161)] })
    const deps: RuleDeps = {
      store,
      settings: { ruleSecretPrefixes: [], chainIds: [8453, 42161] },
      now: () => '2026-09-21T00:00:00.000Z',
    }
    // shaped exactly right - all four attributes present as strings - but GSI1PK is 42161's partition while
    // the envelope's own chainId claims to be resuming 8453
    const forged = encodeCursor({
      chainId: 8453,
      key: { PK: 'RULE#a1', SK: 'META', GSI1PK: 'CHAIN#42161#RULES', GSI1SK: 'RULE#a1' },
    })
    const result = await handleListRules(
      deps,
      apiEvent({ routeKey: 'GET /v1/rules', queryStringParameters: { cursor: forged } }),
    )
    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe('invalid_cursor')
  })
})
