import { describe, expect, it } from 'vitest'
import { validateRuleInput, type RuleSettings } from '../../src/rules.js'

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
