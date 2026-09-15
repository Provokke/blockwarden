import { matchKey } from '@blockwarden/core'
import fc from 'fast-check'
import { hexToBigInt, HttpRequestError, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { DROP_AFTER_BLOCKS, LEASE_MS, runCycle } from '../../src/cycle.js'
import type { NewMatch, StoredRule } from '../../src/store.js'
import {
  CHAIN_ID,
  FakeChain,
  InMemoryStore,
  pingRule,
  type CrashPhase,
  type FakeBlock,
  type FakeTx,
  type FinalizedFault,
  type StoreOp,
  type TxSpec,
} from './fakes.js'

const MAX_DEPTH = 8

const value = fc.bigInt({ min: 0n, max: 20n })
const replacementTx = fc.record({
  // an orphaned transaction goes back to the mempool and can land in any replacement block
  reinclude: fc.option(fc.nat(), { nil: undefined }),
  sameValues: fc.boolean(),
  values: fc.array(value, { minLength: 1, maxLength: 3 }),
})
const reorgOp = fc.record({
  kind: fc.constant('reorg' as const),
  depth: fc.integer({ min: 1, max: MAX_DEPTH }),
  blocks: fc.array(fc.array(replacementTx, { maxLength: 3 }), { maxLength: MAX_DEPTH + 2 }),
})
const restoreOp = fc.record({ kind: fc.constant('restore' as const) })
const chainOp = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant('mine' as const), n: fc.integer({ min: 1, max: 6 }) }), weight: 2 },
  // longer than DROP_AFTER_BLOCKS plus the largest lag, so one run can drop an orphaned provisional match
  { arbitrary: fc.record({ kind: fc.constant('mine' as const), n: fc.integer({ min: 90, max: 110 }) }), weight: 2 },
  {
    arbitrary: fc.record({
      kind: fc.constant('includeOrphan' as const),
      pick: fc.nat(),
      sameValues: fc.boolean(),
      values: fc.array(value, { minLength: 1, maxLength: 3 }),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant('include' as const),
      txs: fc.array(fc.record({ values: fc.array(value, { minLength: 1, maxLength: 3 }) }), {
        minLength: 1,
        maxLength: 3,
      }),
    }),
    weight: 3,
  },
  { arbitrary: reorgOp, weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant('snapshot' as const) }), weight: 1 },
  { arbitrary: restoreOp, weight: 1 },
)
type ChainOp = typeof chainOp extends fc.Arbitrary<infer T> ? T : never

const storeOps: StoreOp[] = [
  'acquireLease',
  'releaseLease',
  'getCursor',
  'saveCursor',
  'listActiveRules',
  'writeProvisional',
  'writeFinal',
  'dropQuery',
  'dropItem',
]

const round = fc.record({
  ops: fc.array(chainOp, { maxLength: 4 }),
  // a fault-free run lets the durable scan catch up, so drops and late finals happen between faulty runs too
  quiet: fc.constantFrom(false, false, true),
  finalizedFlake: fc.constantFrom(0, 0, 0.3, 1),
  finalizedKind: fc.constantFrom<FinalizedFault>('rpc-error', 'transport', 'stale'),
  staleHeadBy: fc.constantFrom(0, 0, 0, 2, 25),
  // a failover backend this far behind the head answers some durable log requests, clamping them silently
  lagBy: fc.constantFrom(0, 0, 3, 30, 120),
  lagFlake: fc.constantFrom(0.3, 1),
  leaseHeld: fc.constantFrom(false, false, false, false, true),
  crash: fc.option(
    fc.record({
      op: fc.constantFrom(...storeOps),
      at: fc.integer({ min: 1, max: 4 }),
      phase: fc.constantFrom<CrashPhase>('before', 'after'),
    }),
    { nil: undefined },
  ),
  conflictAtSave: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
  overlapping: fc.boolean(),
  midCycle: fc.option(fc.record({ atLogs: fc.integer({ min: 1, max: 3 }), change: fc.oneof(reorgOp, restoreOp) }), {
    nil: undefined,
  }),
  budgetAfterLogs: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
  // a node that caps eth_getLogs at a few blocks makes both scans halve their ranges
  rangeLimit: fc.constantFrom(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 1, 2, 3),
  // each log request can be the one during which the deadline passes, often inside a halved range
  deadlineFlake: fc.constantFrom(0, 0, 0.2, 0.5),
})

const setup = fc.record({
  finalizedLag: fc.integer({ min: 4, max: 24 }),
  useFinalityDepth: fc.boolean(),
  maxRange: fc.integer({ min: 1, max: 8 }),
  mins: fc.tuple(value, value, value),
  seed: fc.integer({ min: 1, max: 0x7fffffff }),
  // unset starts at the finalized block of the first run that creates the cursor; above the head it stays exclusive
  startBlock: fc.oneof(fc.constant(undefined), fc.constant(0), fc.integer({ min: 1, max: 40 })),
})

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const minValue = (rule: StoredRule) => BigInt((rule.input.conditions as { value: string }).value)

describe('scanning invariant', () => {
  it('leaves exactly the canonical finalized matches final and no stale provisional match, after any faults', async () => {
    // counted across every run, so the property fails if the generator stops producing the cases it exists for
    const seen = { reorgsWithLogs: 0, droppedToFinal: 0, eventsInBothScans: 0 }

    await fc.assert(
      fc.asyncProperty(fc.array(round, { minLength: 1, maxLength: 12 }), setup, async (plan, s) => {
        const random = mulberry32(s.seed)
        const chain = new FakeChain(8, s.finalizedLag)
        const store = new InMemoryStore()
        const rules = [
          pingRule('fast', { mode: 'fast' }, s.mins[0]),
          pingRule('finalized', { mode: 'finalized' }, s.mins[1]),
          pingRule('fast-too', { mode: 'fast' }, s.mins[2]),
        ]
        store.rules.push(...rules)
        let clock = 1_800_000_000_000
        let logsAtRoundStart = 0
        let budgetAfterLogs: number | undefined
        let deadlineFlake = 0
        let deadlinePassed = false
        const now = () =>
          clock +
          (deadlinePassed || (budgetAfterLogs !== undefined && chain.getLogsCalls - logsAtRoundStart >= budgetAfterLogs)
            ? 60_000
            : 0)
        const read = chain.getLogs.bind(chain)
        // the request that sees the deadline pass still completes; the next shouldStop check stops the scan
        chain.getLogs = async (filter, from, to) => {
          if (deadlineFlake > 0 && random() < deadlineFlake) deadlinePassed = true
          return read(filter, from, to)
        }
        const cycle = () =>
          runCycle({
            chainId: CHAIN_ID,
            chain,
            store,
            maxRange: s.maxRange,
            timeBudgetMs: 50_000,
            deadlineMs: clock + 45_000,
            now,
            ...(s.startBlock === undefined ? {} : { startBlock: s.startBlock }),
            ...(s.useFinalityDepth ? { finalityDepth: s.finalizedLag } : {}),
          })

        // the match keys each scan computed for an event, by block hash, log index and rule
        const fastKeys = new Map<string, Set<Hex>>()
        const durableKeys = new Map<string, Set<Hex>>()
        const note = (keys: Map<string, Set<Hex>>, m: NewMatch) => {
          const event = `${m.blockHash}|${m.logIndex}|${m.ruleId}`
          keys.set(event, (keys.get(event) ?? new Set<Hex>()).add(m.matchKey))
        }
        const writeProvisional = store.writeProvisional.bind(store)
        store.writeProvisional = async (m) => {
          note(fastKeys, m)
          return writeProvisional(m)
        }
        const writeFinal = store.writeFinal.bind(store)
        store.writeFinal = async (m) => {
          note(durableKeys, m)
          const before = store.matches.get(m.matchKey)?.status
          const result = await writeFinal(m)
          if (before === 'dropped' && result === 'upgraded') seen.droppedToFinal++
          return result
        }
        // the durable block the cursor was created at; the durable scan never reads it or anything below it
        let origin: number | undefined
        const saveCursor = store.saveCursor.bind(store)
        store.saveCursor = async (chainId, next) => {
          try {
            return await saveCursor(chainId, next)
          } finally {
            origin ??= store.cursors.get(CHAIN_ID)?.durableBlock
          }
        }

        let fork: FakeBlock[] | undefined
        // orphaned transactions wait here and can be mined again at any later height
        const mempool = new Map<Hex, FakeTx>()
        let highestLogBlock = 0
        const apply = (o: ChainOp) => {
          if (o.kind === 'mine') chain.mine(o.n)
          else if (o.kind === 'include') chain.include(...o.txs)
          else if (o.kind === 'snapshot') fork = chain.snapshot()
          else if (o.kind === 'restore') {
            if (fork && chain.canRestore(fork)) {
              const kept = new Set(fork.flatMap((b) => b.txs.map((t) => t.hash)))
              for (const tx of chain.blocks.flatMap((b) => b.txs)) if (!kept.has(tx.hash)) mempool.set(tx.hash, tx)
              chain.restore(fork)
            }
          } else if (o.kind === 'includeOrphan') {
            const canonical = new Set(chain.blocks.flatMap((b) => b.txs.map((t) => t.hash)))
            const waiting = [...mempool.values()].filter((t) => !canonical.has(t.hash))
            const tx = waiting[o.pick % Math.max(1, waiting.length)]
            if (tx) chain.include({ hash: tx.hash, values: o.sameValues ? tx.values : o.values })
          } else {
            const depth = Math.min(o.depth, chain.head - chain.finalizedFloor)
            if (depth <= 0) return
            const orphans = chain.blocks.slice(chain.blocks.length - depth).flatMap((b) => b.txs)
            const reincluded = new Set<Hex>()
            const replacement: TxSpec[][] = o.blocks.map((txs) =>
              txs.flatMap((t) => {
                if (t.reinclude === undefined || orphans.length === 0) return [{ values: t.values }]
                const orphan = orphans[t.reinclude % orphans.length]!
                if (reincluded.has(orphan.hash)) return []
                reincluded.add(orphan.hash)
                return [{ hash: orphan.hash, values: t.sameValues ? orphan.values : t.values }]
              }),
            )
            if (replacement.some((txs) => txs.length > 0)) seen.reorgsWithLogs++
            for (const b of chain.reorg(depth, replacement)) for (const tx of b.txs) mempool.set(tx.hash, tx)
          }
          for (const b of chain.blocks) if (b.logs.length > 0) highestLogBlock = Math.max(highestLogBlock, b.number)
        }

        for (const planned of plan) {
          const r = planned.quiet
            ? {
                ...planned,
                finalizedFlake: 0,
                staleHeadBy: 0,
                lagBy: 0,
                leaseHeld: false,
                crash: undefined,
                conflictAtSave: undefined,
                midCycle: undefined,
                budgetAfterLogs: undefined,
                rangeLimit: Number.POSITIVE_INFINITY,
                deadlineFlake: 0,
              }
            : planned
          for (const o of r.ops) apply(o)

          clock += LEASE_MS + 1
          logsAtRoundStart = chain.getLogsCalls
          budgetAfterLogs = r.budgetAfterLogs
          deadlineFlake = r.deadlineFlake
          deadlinePassed = false
          chain.rangeLimit = r.rangeLimit
          chain.finalizedFault =
            r.finalizedFlake > 0 ? () => (random() < r.finalizedFlake ? r.finalizedKind : undefined) : undefined
          chain.staleHeadBy = r.staleHeadBy
          chain.lagHead =
            r.lagBy > 0 ? () => (random() < r.lagFlake ? Math.max(0, chain.head - r.lagBy) : undefined) : undefined
          const midCycle = r.midCycle
          chain.beforeGetLogs =
            midCycle && ((call) => void (call - logsAtRoundStart === midCycle.atLogs && apply(midCycle.change)))
          if (r.leaseHeld) store.leases.set(CHAIN_ID, { owner: 'another poller', leaseUntil: clock + LEASE_MS })
          store.crashOn(r.crash?.op, r.crash?.at, r.crash?.phase)
          store.saveCount = 0
          store.beforeSave =
            r.conflictAtSave === undefined
              ? undefined
              : async (save) => {
                  if (save !== r.conflictAtSave) return
                  store.beforeSave = undefined
                  if (r.overlapping) {
                    const overlap = await cycle().then(
                      (result) => result.status,
                      (err: Error) => err.message,
                    )
                    expect(['busy', 'simulated crash']).toContain(overlap)
                  }
                  store.conflictOnNextSave = true
                }

          const readsBefore = chain.readCalls
          let outcome: string
          try {
            const result = await cycle()
            outcome = result.status
            if (result.laggingNode) expect(r.lagBy).toBeGreaterThan(0)
            if (result.deadlineHit) expect(r.budgetAfterLogs !== undefined || r.deadlineFlake > 0).toBe(true)
          } catch (err) {
            if (err instanceof HttpRequestError) outcome = 'transport'
            else {
              expect((err as Error).message).toBe('simulated crash')
              outcome = 'crashed'
            }
          }

          if (outcome === 'busy') {
            expect(r.leaseHeld).toBe(true)
            expect(chain.readCalls).toBe(readsBefore)
          }
          if (outcome === 'crashed') expect(r.crash).toBeDefined()
          if (outcome === 'transport') expect(r.finalizedKind).toBe('transport')
          if (r.leaseHeld) expect(['busy', 'crashed']).toContain(outcome)

          chain.beforeGetLogs = undefined
          store.beforeSave = undefined
          store.conflictOnNextSave = false
          store.crashOn(undefined)
        }

        chain.finalizedFault = undefined
        chain.staleHeadBy = 0
        chain.lagHead = undefined
        chain.rangeLimit = Number.POSITIVE_INFINITY
        budgetAfterLogs = undefined
        deadlineFlake = 0
        deadlinePassed = false
        clock += LEASE_MS + 1
        const target = Math.max(highestLogBlock, chain.head, s.startBlock ?? 0) + DROP_AFTER_BLOCKS
        chain.mine(Math.max(0, target + s.finalizedLag - chain.head))
        expect(chain.finalizedFloor).toBeGreaterThanOrEqual(highestLogBlock)

        const durableBlock = () => store.cursors.get(CHAIN_ID)?.durableBlock
        let runs = 0
        do {
          expect((await cycle()).status).toBe('ok')
        } while (durableBlock() !== chain.finalizedFloor && ++runs < 5)
        expect(durableBlock()).toBe(chain.finalizedFloor)
        const durable = durableBlock()!
        expect(origin).toBeDefined()
        if (s.startBlock !== undefined) expect(origin).toBe(s.startBlock)

        const expected: string[] = []
        for (const block of chain.blocks.slice(origin! + 1, durable + 1)) {
          const ordinals = new Map<string, number>()
          for (const log of block.logs) {
            const v = hexToBigInt(log.data)
            for (const rule of rules) {
              if (v < minValue(rule)) continue
              const group = `${log.transactionHash}:${rule.ruleId}`
              const ordinal = ordinals.get(group) ?? 0
              ordinals.set(group, ordinal + 1)
              const key = matchKey(CHAIN_ID, log.transactionHash, ordinal, rule.ruleId)
              expected.push(`${key}|${rule.ruleId}|${block.number}|${block.hash}|${log.logIndex}|${ordinal}|${v}`)
            }
          }
        }
        const actual = store
          .withStatus('final')
          .map(
            (m) =>
              `${m.matchKey}|${m.ruleId}|${m.blockNumber}|${m.blockHash}|${m.logIndex}|${m.ordinal}|${m.args.value}`,
          )
        expect(actual.sort()).toEqual(expected.sort())

        const stale = store.withStatus('provisional').filter((m) => m.blockNumber <= durable - DROP_AFTER_BLOCKS)
        expect(stale).toEqual([])

        // an event in one block has one ordinal, so both scans must have keyed it the same way
        for (const [event, keys] of fastKeys) {
          const finalKeys = durableKeys.get(event)
          if (!finalKeys) continue
          seen.eventsInBothScans++
          expect([...keys]).toEqual([...finalKeys])
          expect(keys.size).toBe(1)
        }
      }),
      { numRuns: 300 },
    )

    expect(seen.reorgsWithLogs).toBeGreaterThan(0)
    expect(seen.droppedToFinal).toBeGreaterThan(0)
    expect(seen.eventsInBothScans).toBeGreaterThan(0)
  }, 240_000)
})
