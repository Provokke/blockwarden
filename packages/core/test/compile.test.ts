import { describe, expect, it } from 'vitest'
import { compileRule, RuleValidationError } from '../src/compile.js'
import { ruleInputSchema } from '../src/rule.js'
import { TOKEN, TRANSFER } from './logs.js'

const base = ruleInputSchema.parse({
  chainId: 1,
  addresses: [TOKEN],
  event: TRANSFER,
  confirmation: { mode: 'fast' },
})

function issuesOf(fn: () => unknown): RuleValidationError['issues'] {
  try {
    fn()
  } catch (err) {
    if (err instanceof RuleValidationError) return err.issues
    throw err
  }
  expect.unreachable('expected a RuleValidationError')
}

describe('compileRule', () => {
  it('returns the parsed event and its topic0', () => {
    const rule = compileRule('r1', base)
    expect(rule.ruleId).toBe('r1')
    expect(rule.abiEvent.name).toBe('Transfer')
    expect(rule.topic0).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
  })

  it('rejects a function signature', () => {
    expect(
      issuesOf(() => compileRule('r', { ...base, event: 'function transfer(address to, uint256 amount)' })),
    ).toEqual([{ path: 'event', message: 'expected an event signature' }])
  })

  it('rejects a signature that does not parse', () => {
    const issues = issuesOf(() => compileRule('r', { ...base, event: 'event Transfer(address' }))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.path).toBe('event')
  })

  it('rejects events with unnamed inputs', () => {
    const issues = issuesOf(() =>
      compileRule('r', { ...base, event: 'event Transfer(address indexed, address indexed, uint256)' }),
    )
    expect(issues).toEqual([{ path: 'event', message: 'input 0 has no name' }])
  })

  it('names every condition field the event cannot provide', () => {
    const conditions = {
      all: [
        { field: 'args.amount', op: 'gte' as const, value: '1' },
        { any: [{ field: 'sender', op: 'eq' as const, value: '0x1' }] },
      ],
    }
    expect(issuesOf(() => compileRule('r', { ...base, conditions }))).toEqual([
      { path: 'conditions.all.0.field', message: 'event has no input named "amount"' },
      { path: 'conditions.all.1.any.0.field', message: 'unknown field "sender"' },
    ])
  })

  it('accepts context fields and nested argument paths', () => {
    const conditions = {
      all: [
        { field: 'address', op: 'eq' as const, value: TOKEN },
        { field: 'args.value', op: 'gte' as const, value: '1' },
        { field: 'args.to.length', op: 'gt' as const, value: 0 },
      ],
    }
    expect(() => compileRule('r', { ...base, conditions })).not.toThrow()
  })
})
