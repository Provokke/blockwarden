import fc from 'fast-check'
import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { compileRule } from '../src/compile.js'
import { buildLogFilter } from '../src/filter.js'
import { assignOrdinals, dedupeLogs, matchLog, type LogMatch } from '../src/match.js'
import { ruleInputSchema } from '../src/rule.js'
import { BOB, TOKEN, TRANSFER, erc20Log, erc721Log } from './logs.js'

function rule(ruleId: string, overrides: Record<string, unknown> = {}) {
  return compileRule(
    ruleId,
    ruleInputSchema.parse({
      chainId: 1,
      addresses: [TOKEN],
      event: TRANSFER,
      confirmation: { mode: 'fast' },
      ...overrides,
    }),
  )
}

describe('matchLog', () => {
  it('returns decoded args when address, event and conditions match', () => {
    const big = rule('big', { conditions: { field: 'args.value', op: 'gte', value: '1000' } })
    const [match] = matchLog([big], erc20Log(5000n))
    expect(match?.rule.ruleId).toBe('big')
    expect(match?.args).toEqual({ from: '0x00000000000000000000000000000000000000AA', to: BOB, value: 5000n })
  })

  it('compares the log address case-insensitively', () => {
    const lower = erc20Log(1n, { address: TOKEN.toLowerCase() as `0x${string}` })
    expect(matchLog([rule('r')], lower)).toHaveLength(1)
  })

  it('skips logs from other contracts and logs whose conditions fail', () => {
    const big = rule('big', { conditions: { field: 'args.value', op: 'gte', value: '1000' } })
    expect(matchLog([big], erc20Log(5000n, { address: `0x${'99'.repeat(20)}` }))).toEqual([])
    expect(matchLog([big], erc20Log(999n))).toEqual([])
  })

  it('treats an ERC-721 Transfer as a different event even though topic0 is the same', () => {
    expect(matchLog([rule('erc20')], erc721Log(7n))).toEqual([])
  })

  it('returns one match per rule that accepts the log', () => {
    expect(matchLog([rule('a'), rule('b')], erc20Log(1n)).map((m) => m.rule.ruleId)).toEqual(['a', 'b'])
  })
})

describe('dedupeLogs', () => {
  const blockHash = `0x${'ab'.repeat(32)}` as Hex

  it('keeps one copy of a log the provider returned twice, so it cannot take a second ordinal', () => {
    const log = erc20Log(1n, { blockHash, logIndex: 2 })
    const next = erc20Log(1n, { blockHash, logIndex: 3 })
    const shouted = { ...log, blockHash: `0x${'AB'.repeat(32)}` as Hex }

    const deduped = dedupeLogs([log, next, { ...log, topics: [...log.topics] }, shouted])

    expect(deduped).toEqual([log, next])
    expect(assignOrdinals(deduped.flatMap((l) => matchLog([rule('r')], l))).map((k) => k.ordinal)).toEqual([0, 1])
  })

  it('keeps logs that share a log index in different blocks', () => {
    const logs = [
      erc20Log(1n, { blockNumber: 1, logIndex: 0 }),
      erc20Log(1n, { blockNumber: 2, blockHash, logIndex: 0 }),
    ]
    expect(dedupeLogs(logs)).toEqual(logs)
  })
})

describe('buildLogFilter', () => {
  it('returns undefined when there are no rules', () => {
    expect(buildLogFilter([])).toBeUndefined()
  })

  it('dedupes addresses and topic0s across rules, lowercased', () => {
    const other = `0x${'AB'.repeat(20)}`
    const filter = buildLogFilter([rule('a'), rule('b', { addresses: [TOKEN.toLowerCase(), other] })])
    expect(filter).toEqual({
      addresses: [TOKEN.toLowerCase(), other.toLowerCase()],
      topic0s: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
    })
  })
})

describe('assignOrdinals', () => {
  const txA = `0x${'aa'.repeat(32)}` as Hex
  const txB = `0x${'bb'.repeat(32)}` as Hex
  const at = (transactionHash: Hex, logIndex: number, blockNumber = 1) => ({
    ...erc20Log(1n, { blockNumber, logIndex }),
    transactionHash,
  })
  const m = (ruleId: string, log: ReturnType<typeof at>): LogMatch => ({ rule: rule(ruleId), args: {}, log })
  const ordinals = (matches: LogMatch[]) =>
    assignOrdinals(matches).map((k) => [k.rule.ruleId, k.log.transactionHash, k.log.logIndex, k.ordinal])

  it('numbers two matching logs of one transaction for one rule 0 and 1', () => {
    expect(ordinals([m('r', at(txA, 3)), m('r', at(txA, 5))])).toEqual([
      ['r', txA, 3, 0],
      ['r', txA, 5, 1],
    ])
  })

  it('counts each rule independently', () => {
    expect(ordinals([m('a', at(txA, 0)), m('b', at(txA, 1)), m('a', at(txA, 2))])).toEqual([
      ['a', txA, 0, 0],
      ['b', txA, 1, 0],
      ['a', txA, 2, 1],
    ])
  })

  it('counts each transaction independently', () => {
    expect(ordinals([m('r', at(txA, 0)), m('r', at(txB, 1)), m('r', at(txA, 2))])).toEqual([
      ['r', txA, 0, 0],
      ['r', txB, 1, 0],
      ['r', txA, 2, 1],
    ])
  })

  it('groups transaction hashes regardless of case', () => {
    const upper = `0x${'AA'.repeat(32)}` as Hex
    expect(ordinals([m('r', at(upper, 4)), m('r', at(txA, 2))])).toEqual([
      ['r', upper, 4, 1],
      ['r', txA, 2, 0],
    ])
  })

  it('numbers a transaction per block, so logs read from two forks never shift each other', () => {
    // a halved fast-scan range is several eth_getLogs calls; a reorg between them can return the transaction twice
    const orphaned = {
      ...erc20Log(1n, { blockNumber: 8, blockHash: `0x${'08'.repeat(32)}`, logIndex: 0 }),
      transactionHash: txA,
    }
    const canonical = {
      ...erc20Log(1n, { blockNumber: 9, blockHash: `0x${'09'.repeat(32)}`, logIndex: 0 }),
      transactionHash: txA,
    }
    expect(ordinals([m('r', orphaned), m('r', canonical)])).toEqual([
      ['r', txA, 0, 0],
      ['r', txA, 0, 0],
    ])
  })

  it('gives the same ordinals for shuffled input', () => {
    const matches = [
      m('a', at(txA, 0)),
      m('b', at(txA, 0)),
      m('a', at(txA, 1)),
      m('a', at(txB, 2)),
      m('b', at(txA, 3)),
      m('a', at(txA, 4)),
    ]
    const shuffled = [matches[4]!, matches[1]!, matches[5]!, matches[3]!, matches[0]!, matches[2]!]
    const byPosition = (rows: unknown[][]) => rows.map((r) => r.join(':')).sort()
    expect(byPosition(ordinals(shuffled))).toEqual(byPosition(ordinals(matches)))
    expect(byPosition(ordinals(matches))).toEqual(
      byPosition([
        ['a', txA, 0, 0],
        ['b', txA, 0, 0],
        ['a', txA, 1, 1],
        ['a', txB, 2, 0],
        ['b', txA, 3, 1],
        ['a', txA, 4, 2],
      ]),
    )
  })

  it('numbers every transaction and rule group 0..n-1 in log order, whatever the input order', () => {
    const txs = [txA, txB, `0x${'AB'.repeat(32)}` as Hex, `0x${'ab'.repeat(32)}` as Hex]
    const rules = ['a', 'b', 'c'].map((id) => rule(id))
    const logs = fc.uniqueArray(
      fc.record({
        logIndex: fc.integer({ min: 0, max: 40 }),
        tx: fc.integer({ min: 0, max: txs.length - 1 }),
        rules: fc.subarray([0, 1, 2], { minLength: 1 }),
      }),
      { selector: (l) => l.logIndex, maxLength: 25 },
    )
    const scenario = logs.chain((ls) => {
      const matches = ls.flatMap((l) =>
        l.rules.map((r) => ({
          rule: rules[r]!,
          args: {},
          // a transaction's logs share a block; two transactions share block 1
          log: at(txs[l.tx]!, l.logIndex, l.tx < 2 ? 1 : 2),
        })),
      )
      return fc.shuffledSubarray(matches, { minLength: matches.length, maxLength: matches.length })
    })

    fc.assert(
      fc.property(scenario, (matches) => {
        const keyed = assignOrdinals(matches)
        expect(keyed.map((k) => [k.rule, k.log])).toEqual(matches.map((mm) => [mm.rule, mm.log]))
        const groups = new Map<string, { blockNumber: number; logIndex: number; ordinal: number }[]>()
        for (const k of keyed) {
          const group = `${k.log.transactionHash.toLowerCase()}:${k.rule.ruleId}`
          groups.set(group, [
            ...(groups.get(group) ?? []),
            { blockNumber: k.log.blockNumber, logIndex: k.log.logIndex, ordinal: k.ordinal },
          ])
        }
        for (const members of groups.values()) {
          members.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex)
          expect(members.map((x) => x.ordinal)).toEqual(members.map((_, i) => i))
        }
      }),
      { numRuns: 300 },
    )
  })
})
