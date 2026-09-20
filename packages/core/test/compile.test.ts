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

  it('accepts context fields and a nested tuple path, and refuses a nested path past a field with no components', () => {
    // `to` is a plain address on Transfer: resolveField on a string never has a `.length` own property,
    // so the old code let this compile a rule whose third condition could never match anything
    const event =
      'event Approved(address indexed from, address indexed to, uint256 value, (address spender, uint256 allowance) grant)'
    const conditions = {
      all: [
        { field: 'address', op: 'eq' as const, value: TOKEN },
        { field: 'args.value', op: 'gte' as const, value: '1' },
        { field: 'args.grant.spender', op: 'eq' as const, value: TOKEN },
        { field: 'args.to.length', op: 'gt' as const, value: 0 },
      ],
    }
    expect(issuesOf(() => compileRule('r', { ...base, event, conditions }))).toEqual([
      { path: 'conditions.all.3.field', message: 'field "to" is a address and has no components' },
    ])
  })
})

describe('action validation', () => {
  const base = {
    chainId: 8453,
    addresses: ['0x1111111111111111111111111111111111111111'],
    event: 'event Transfer(address indexed from, address indexed to, uint256 value)',
    confirmation: { mode: 'finalized' } as const,
  }

  it('compiles a rule whose actions all pass their channel schema', () => {
    const rule = ruleInputSchema.parse({
      ...base,
      actions: [
        { type: 'webhook', url: 'https://example.com/hook' },
        { type: 'email', to: ['ops@example.com'] },
      ],
    })
    expect(compileRule('r1', rule).actions).toHaveLength(2)
  })

  it('refuses a rule whose webhook URL points at the metadata endpoint', () => {
    const result = ruleInputSchema.safeParse({
      ...base,
      actions: [{ type: 'webhook', url: 'https://169.254.169.254/latest/meta-data/' }],
    })
    expect(result.success).toBe(false)
  })
})

describe('nested condition fields', () => {
  const tupleEvent =
    'event PermissionApproved((address account, address spender, uint160 allowance) permission, bytes32 hash)'

  const inputFor = (field: string) => ({
    chainId: 8453,
    addresses: ['0x1111111111111111111111111111111111111111'],
    event: tupleEvent,
    conditions: { all: [{ field, op: 'eq' as const, value: '0x2222222222222222222222222222222222222222' }] },
    confirmation: { mode: 'finalized' } as const,
    actions: [],
  })

  it('accepts a path into a tuple component', () => {
    expect(compileRule('r1', ruleInputSchema.parse(inputFor('args.permission.spender'))).ruleId).toBe('r1')
  })

  it('refuses a component the tuple does not have', () => {
    expect(() => compileRule('r1', ruleInputSchema.parse(inputFor('args.permission.nope')))).toThrow(
      'tuple "permission" has no component named "nope"',
    )
  })

  it('refuses a path that walks into something that is not a tuple', () => {
    expect(() => compileRule('r1', ruleInputSchema.parse(inputFor('args.hash.inner')))).toThrow(
      'field "hash" is a bytes32 and has no components',
    )
  })

  it('still refuses an unknown first segment', () => {
    expect(() => compileRule('r1', ruleInputSchema.parse(inputFor('args.missing')))).toThrow(
      'event has no input named "missing"',
    )
  })
})
