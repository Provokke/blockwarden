import { describe, expect, it } from 'vitest'
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, parseAbiItem, type AbiEvent, type Hex } from 'viem'
import { compileRule, RuleValidationError } from '../src/compile.js'
import { resolveField } from '../src/conditions.js'
import { ruleInputSchema, type RuleInput } from '../src/rule.js'
import { ALICE, BOB, TOKEN, TRANSFER } from './logs.js'

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
      { path: 'conditions.all.3.field', message: 'field "to" is an address and has no components' },
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

  // a rule stored by any path other than scripts/put-rule.ts reaches the monitor without ruleInputSchema,
  // so compileRule is the last gate before the dispatcher
  it('refuses an action the channel schema refuses, naming the field', () => {
    const rule = {
      ...ruleInputSchema.parse(base),
      actions: [{ type: 'webhook', url: 'http://example.com/hook' }],
    } as RuleInput
    expect(issuesOf(() => compileRule('r1', rule))).toEqual([
      { path: 'actions.0.url', message: 'the URL must be https' },
    ])
  })

  it('refuses an unknown channel by its type', () => {
    const rule = {
      ...ruleInputSchema.parse(base),
      actions: [{ type: 'slack', url: 'https://e.com/h' }],
    } as unknown as RuleInput
    const issues = issuesOf(() => compileRule('r1', rule))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.path).toBe('actions.0.type')
    expect(issues[0]?.message).toBeTruthy()
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

describe('array condition fields', () => {
  // a real Batch log: one item for Bob with two amounts, and a two-entry amounts array
  const BATCH = 'event Batch((address to, uint256[] amts)[] items, uint256[] amounts, address indexed operator)'
  const batchEvent = parseAbiItem(BATCH) as AbiEvent
  const decoded = decodeEventLog({
    abi: [batchEvent],
    topics: encodeEventTopics({ abi: [batchEvent], eventName: 'Batch', args: { operator: ALICE } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      batchEvent.inputs.filter((i) => !i.indexed),
      [[{ to: BOB, amts: [3n, 4n] }], [7n, 9n]],
    ),
  })
  const ctx = { args: decoded.args as Record<string, unknown> }

  const inputFor = (field: string) => ({
    ...base,
    event: BATCH,
    conditions: { all: [{ field, op: 'eq' as const, value: '1' }] },
  })

  it('resolves the live paths a decoded array log really has', () => {
    expect(resolveField(ctx, 'args.amounts.length')).toBe(2)
    expect(resolveField(ctx, 'args.amounts.0')).toBe(7n)
    expect(String(resolveField(ctx, 'args.items.0.to')).toLowerCase()).toBe(BOB.toLowerCase())
    expect(resolveField(ctx, 'args.items.length')).toBe(1)
    expect(resolveField(ctx, 'args.items.0.amts.1')).toBe(4n)
  })

  it('accepts a length, an index and a path through an array of tuples', () => {
    for (const field of [
      'args.amounts.length',
      'args.amounts.0',
      'args.items.0.to',
      'args.items.length',
      'args.items.0.amts.length',
      'args.items.0.amts.1',
    ]) {
      expect(() => compileRule('r', inputFor(field)), field).not.toThrow()
    }
  })

  it('refuses a component an array element does not have', () => {
    expect(issuesOf(() => compileRule('r', inputFor('args.items.0.unknown')))).toEqual([
      { path: 'conditions.all.0.field', message: 'tuple "items.0" has no component named "unknown"' },
    ])
  })

  it('refuses a segment that is neither an index nor a length', () => {
    expect(issuesOf(() => compileRule('r', inputFor('args.amounts.first')))).toEqual([
      {
        path: 'conditions.all.0.field',
        message: 'field "amounts" is a uint256[]; expected an index or "length"',
      },
    ])
  })

  it('refuses a path past a length, which is a number', () => {
    expect(issuesOf(() => compileRule('r', inputFor('args.amounts.length.0')))).toEqual([
      { path: 'conditions.all.0.field', message: 'field "amounts.length" is a number and has no components' },
    ])
  })

  it('still refuses a length or an index on a scalar', () => {
    for (const [field, message] of [
      ['args.operator.length', 'field "operator" is an address and has no components'],
      ['args.operator.0', 'field "operator" is an address and has no components'],
      ['args.amounts.0.length', 'field "amounts.0" is a uint256 and has no components'],
    ]) {
      expect(
        issuesOf(() => compileRule('r', inputFor(field as string))),
        field,
      ).toEqual([{ path: 'conditions.all.0.field', message }])
    }
  })
})
