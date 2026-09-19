import { describe, expect, it } from 'vitest'
import { ruleInputSchema } from '../src/rule.js'

const valid = {
  chainId: 8453,
  addresses: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
  event: 'event Transfer(address indexed from, address indexed to, uint256 value)',
  conditions: {
    all: [
      { field: 'args.value', op: 'gte', value: '1000000' },
      { any: [{ field: 'args.to', op: 'eq', value: '0x0000000000000000000000000000000000000001' }] },
    ],
  },
  confirmation: { mode: 'finalized' },
}

describe('ruleInputSchema', () => {
  it('accepts a nested rule and defaults actions to empty', () => {
    const parsed = ruleInputSchema.parse(valid)
    expect(parsed.actions).toEqual([])
    expect(parsed.confirmation).toEqual({ mode: 'finalized' })
  })

  it('reports the path of a bad address', () => {
    const result = ruleInputSchema.safeParse({ ...valid, addresses: ['0x123'] })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['addresses', 0])
  })

  it('accepts fast mode', () => {
    expect(ruleInputSchema.parse({ ...valid, confirmation: { mode: 'fast' } }).confirmation).toEqual({ mode: 'fast' })
  })

  it('rejects confirmed mode even with a block count', () => {
    expect(ruleInputSchema.safeParse({ ...valid, confirmation: { mode: 'confirmed', blocks: 12 } }).success).toBe(false)
  })

  it('rejects an unknown operator inside a group', () => {
    const conditions = { all: [{ field: 'args.value', op: 'like', value: '1' }] }
    expect(ruleInputSchema.safeParse({ ...valid, conditions }).success).toBe(false)
  })

  it('refuses an unknown action key, so a misspelt option is not silently dropped', () => {
    const parsed = ruleInputSchema.parse({ ...valid, actions: [{ type: 'webhook', url: 'https://example.com' }] })
    expect(parsed.actions).toEqual([{ type: 'webhook', url: 'https://example.com' }])
    const result = ruleInputSchema.safeParse({
      ...valid,
      actions: [{ type: 'webhook', url: 'https://example.com', secrets: 'x' }],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path[0]).toBe('actions')
  })
})
