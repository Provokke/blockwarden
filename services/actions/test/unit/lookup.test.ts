import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { describe, expect, it } from 'vitest'
import { createLookup } from '../../src/lookup.js'

const EVENT = 'event Transfer(address indexed from, address indexed to, uint256 value)'

type Line = { message: string; data?: Record<string, unknown>; level?: string }

function lookupOf(item: Record<string, unknown> | undefined) {
  const lines: Line[] = []
  const doc = { send: async () => ({ Item: item }) } as unknown as DynamoDBDocumentClient
  const lookup = createLookup(doc, 'table', { log: (message, data, level) => lines.push({ message, data, level }) })
  return { lookup, lines }
}

const ruleItem = (input: unknown) => ({ PK: 'RULE#r1', SK: 'META', ruleId: 'r1', input })

describe('lookup.rule', () => {
  it('keeps the actions that pass and drops the one that does not, warning once', async () => {
    const { lookup, lines } = lookupOf(
      ruleItem({
        chainId: 8453,
        addresses: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
        event: EVENT,
        confirmation: { mode: 'finalized' },
        actions: [
          { type: 'webhook', url: 'http://example.com/hook' },
          { type: 'email', to: ['ops@example.com'] },
        ],
      }),
    )

    const rule = await lookup.rule('r1')

    expect(rule?.actions.map((a) => a.action.type)).toEqual(['email'])
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('warn')
    expect(String(lines[0]?.data?.warnings)).toContain('actions.0.url')
  })

  // a rule written before milestone 3 has no actions key at all; reading it must not look like a broken rule
  it('reads a rule stored without an actions list', async () => {
    const { lookup, lines } = lookupOf(
      ruleItem({
        chainId: 8453,
        addresses: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
        event: EVENT,
        confirmation: { mode: 'fast' },
      }),
    )

    const rule = await lookup.rule('r1')

    expect(rule).toMatchObject({ ruleId: 'r1', eventName: 'Transfer', mode: 'fast', actions: [] })
    expect(lines).toEqual([])
  })

  it('skips a rule whose event signature does not parse', async () => {
    const { lookup, lines } = lookupOf(
      ruleItem({
        chainId: 8453,
        addresses: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
        event: 'event Transfer(address',
        confirmation: { mode: 'fast' },
        actions: [],
      }),
    )

    expect(await lookup.rule('r1')).toBeUndefined()
    expect(lines[0]?.level).toBe('warn')
    expect(String(lines[0]?.data?.error)).toContain('cannot parse event signature')
  })
})
