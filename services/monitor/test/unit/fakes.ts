import { DeadlineError, ruleInputSchema, type LogFilter, type RawLog, type RuleInput } from '@blockwarden/core'
import { toStorable } from '@blockwarden/dynamo'
import { encodeAbiParameters, encodeEventTopics, HttpRequestError, parseAbiItem, type Hex } from 'viem'
import type { ChainReader } from '../../src/chain.js'
import {
  CursorConflictError,
  type Cursor,
  type FinalWrite,
  type MatchRecord,
  type MonitorStorePort,
  type NewMatch,
  type StoredRule,
} from '../../src/store.js'

export const CHAIN_ID = 31337
export const PING = 'event Ping(address indexed from, uint256 value)'
export const EMITTER = '0x5fbdb2315678afecb367f032d93f642f64180aa3' as Hex
export const GENESIS_TIME = 1_700_000_000
export const BLOCK_TIME = 2
const SENDER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Hex
const pingEvent = parseAbiItem(PING)
const pingTopics = encodeEventTopics({ abi: [pingEvent], eventName: 'Ping', args: { from: SENDER } }) as Hex[]

export type TxSpec = { hash?: Hex; values: bigint[] }
export type FakeTx = { hash: Hex; values: bigint[] }
export type FakeBlock = {
  number: number
  hash: Hex
  parentHash: Hex
  timestamp: number
  txs: FakeTx[]
  logs: RawLog[]
}
// rpc-error is what the reader reports as undefined; transport propagates; stale is a lagging backend
export type FinalizedFault = 'rpc-error' | 'transport' | 'stale'

export class FakeChain implements ChainReader {
  blocks: FakeBlock[] = []
  // the highest block that has ever been finalized; nothing at or below it may change
  finalizedFloor = 0
  finalizedFault: (() => FinalizedFault | undefined) | undefined
  staleHeadBy = 0
  // the head of a lagging backend answering a batched log request; undefined is a healthy node
  lagHead: (() => number | undefined) | undefined
  rangeLimit = Number.POSITIVE_INFINITY
  beforeGetLogs: ((call: number) => void) | undefined
  getLogsCalls = 0
  getFinalizedCalls = 0
  readCalls = 0
  // the fake never aborts a request; a test makes a method throw DeadlineError to stand in for the hard stop
  hardStops: (number | undefined)[] = []
  private nextId = 1

  constructor(
    height = 0,
    readonly finalizedLag = 64,
  ) {
    this.append([])
    this.mine(height)
  }

  get head(): number {
    return this.blocks.length - 1
  }

  get finalized(): number {
    return this.finalizedFloor
  }

  mine(count: number): void {
    for (let i = 0; i < count; i++) this.append([])
    this.advanceFinality()
  }

  emit(...values: bigint[]): FakeBlock {
    return this.include({ values })
  }

  include(...txs: TxSpec[]): FakeBlock {
    const block = this.append(txs)
    this.advanceFinality()
    return block
  }

  reorg(depth: number, replacement: TxSpec[][] = Array.from({ length: depth }, () => [])): FakeBlock[] {
    if (depth > this.head - this.finalizedFloor) {
      throw new Error(`a reorg of ${depth} at head ${this.head} would reach finalized block ${this.finalizedFloor}`)
    }
    const orphaned = this.blocks.splice(this.blocks.length - depth, depth)
    for (const txs of replacement) this.append(txs)
    this.advanceFinality()
    return orphaned
  }

  snapshot(): FakeBlock[] {
    return [...this.blocks]
  }

  canRestore(fork: FakeBlock[]): boolean {
    let at = 0
    while (at < this.blocks.length && at < fork.length && this.blocks[at]!.hash === fork[at]!.hash) at++
    return at > this.finalizedFloor
  }

  restore(fork: FakeBlock[]): void {
    if (!this.canRestore(fork)) throw new Error('restoring this fork would change a finalized block')
    this.blocks = [...fork]
    this.advanceFinality()
  }

  logsAtOrBelow(block: number): RawLog[] {
    return this.blocks.slice(0, block + 1).flatMap((b) => b.logs)
  }

  setHardStop(epochMs: number | undefined): void {
    this.hardStops.push(epochMs)
  }

  // the fake keeps no remembered heads
  resetRememberedHeads(): void {}

  async getHead(): Promise<number> {
    this.readCalls++
    return Math.max(0, this.head - this.staleHeadBy)
  }

  async getFinalized(): Promise<{ number: number; timestamp: number } | undefined> {
    this.readCalls++
    this.getFinalizedCalls++
    const fault = this.finalizedFault?.()
    if (fault === 'rpc-error') return undefined
    if (fault === 'transport') throw new HttpRequestError({ url: 'http://fake-rpc', status: 503 })
    const number = fault === 'stale' ? Math.max(0, this.finalizedFloor - 7) : this.finalizedFloor
    return { number, timestamp: this.blocks[number]!.timestamp }
  }

  async getLogs(filter: LogFilter, from: number, to: number): Promise<RawLog[]> {
    this.readCalls++
    this.getLogsCalls++
    if (to - from + 1 > this.rangeLimit) throw new Error('block range too large')
    this.beforeGetLogs?.(this.getLogsCalls)
    const addresses = new Set(filter.addresses.map((a) => a.toLowerCase()))
    const topics = new Set(filter.topic0s.map((t) => t.toLowerCase()))
    return this.blocks
      .slice(from, to + 1)
      .flatMap((b) => b.logs)
      .filter((l) => addresses.has(l.address.toLowerCase()) && topics.has(l.topics[0]!.toLowerCase()))
      .map((l) => ({ ...l, topics: [...l.topics] }))
  }

  // one batched request, so it reads through getLogs: range limits, call counts and mid-cycle hooks apply to both scans
  async getLogsWithHead(
    filter: LogFilter,
    from: number,
    to: number,
    options?: { shouldStop?: () => boolean },
  ): Promise<{ logs: RawLog[]; head: number; headBefore: number }> {
    if (options?.shouldStop?.()) throw new DeadlineError()
    const lag = this.lagHead?.()
    const logs = await this.getLogs(filter, from, to)
    if (lag === undefined || lag >= this.head) return { logs, head: this.head, headBefore: this.head }
    // Erigon and Besu answer a range past their head with the logs they have, not an error
    return { logs: logs.filter((l) => l.blockNumber <= lag), head: lag, headBefore: lag }
  }

  private advanceFinality(): void {
    this.finalizedFloor = Math.max(this.finalizedFloor, this.head - this.finalizedLag)
  }

  private id(): Hex {
    return `0x${(this.nextId++).toString(16).padStart(64, '0')}`
  }

  private append(specs: TxSpec[]): FakeBlock {
    const number = this.blocks.length
    const hash = this.id()
    const parentHash = number === 0 ? (`0x${'0'.repeat(64)}` as Hex) : this.blocks[number - 1]!.hash
    const txs = specs.map((s) => ({ hash: s.hash ?? this.id(), values: [...s.values] }))
    const logs: RawLog[] = []
    for (const tx of txs) {
      for (const value of tx.values) {
        logs.push({
          address: EMITTER,
          topics: pingTopics,
          data: encodeAbiParameters([{ type: 'uint256' }], [value]),
          blockNumber: number,
          blockHash: hash,
          transactionHash: tx.hash,
          logIndex: logs.length,
        })
      }
    }
    const block = { number, hash, parentHash, timestamp: GENESIS_TIME + number * BLOCK_TIME, txs, logs }
    this.blocks.push(block)
    return block
  }
}

export type StoreOp =
  | 'acquireLease'
  | 'releaseLease'
  | 'getCursor'
  | 'saveCursor'
  | 'listActiveRules'
  | 'writeProvisional'
  | 'writeFinal'
  | 'dropQuery'
  | 'dropItem'

// before: the request fails; after: the request is applied but its response is lost
export type CrashPhase = 'before' | 'after'

export class InMemoryStore implements MonitorStorePort {
  readonly cursors = new Map<number, Cursor>()
  readonly rules: StoredRule[] = []
  readonly matches = new Map<string, MatchRecord>()
  readonly leases = new Map<number, { owner: string; leaseUntil: number }>()
  readonly finalWrites: { matchKey: Hex; result: FinalWrite }[] = []
  conflictOnNextSave = false
  saveCount = 0
  beforeSave: ((save: number) => Promise<void>) | undefined
  clock: () => Date = () => new Date('2026-09-15T12:00:00.000Z')
  private crash: { op: StoreOp; at: number; phase: CrashPhase; calls: number } | undefined

  crashOn(op: StoreOp | undefined, at = 1, phase: CrashPhase = 'before'): void {
    this.crash = op && { op, at, phase, calls: 0 }
  }

  async acquireLease(chainId: number, owner: string, nowMs: number, ttlMs: number): Promise<boolean> {
    return this.op('acquireLease', () => {
      const held = this.leases.get(chainId)
      if (held && !(held.leaseUntil < nowMs)) return false
      this.leases.set(chainId, { owner, leaseUntil: nowMs + ttlMs })
      return true
    })
  }

  async releaseLease(chainId: number, owner: string): Promise<void> {
    return this.op('releaseLease', () => {
      if (this.leases.get(chainId)?.owner === owner) this.leases.delete(chainId)
    })
  }

  async getCursor(chainId: number): Promise<Cursor | undefined> {
    return this.op('getCursor', () => {
      const cursor = this.cursors.get(chainId)
      return cursor && { ...cursor }
    })
  }

  async saveCursor(chainId: number, next: Cursor): Promise<Cursor> {
    await this.beforeSave?.(++this.saveCount)
    return this.op('saveCursor', () => {
      const current = this.cursors.get(chainId)
      if (this.conflictOnNextSave || (current?.version ?? 0) !== next.version) {
        this.conflictOnNextSave = false
        throw new CursorConflictError(chainId)
      }
      const saved = { durableBlock: next.durableBlock, fastBlock: next.fastBlock, version: next.version + 1 }
      this.cursors.set(chainId, saved)
      return { ...saved }
    })
  }

  async listActiveRules(chainId: number): Promise<StoredRule[]> {
    return this.op('listActiveRules', () => this.rules.filter((r) => r.active && r.input.chainId === chainId))
  }

  async writeProvisional(match: NewMatch): Promise<boolean> {
    return this.op('writeProvisional', () => {
      if (this.matches.has(match.matchKey)) return false
      this.matches.set(match.matchKey, { ...fields(match), status: 'provisional', firstSeenAt: match.firstSeenAt })
      return true
    })
  }

  async writeFinal(match: NewMatch): Promise<FinalWrite> {
    return this.op('writeFinal', () => {
      const stored = this.matches.get(match.matchKey)
      let result: FinalWrite
      if (stored?.status === 'final') {
        result = 'unchanged'
      } else {
        this.matches.set(match.matchKey, {
          ...fields(match),
          status: 'final',
          firstSeenAt: stored?.firstSeenAt ?? match.firstSeenAt,
          finalizedAt: this.clock().toISOString(),
        })
        result = stored ? 'upgraded' : 'created'
      }
      this.finalWrites.push({ matchKey: match.matchKey, result })
      return result
    })
  }

  async dropStaleProvisional(chainId: number, maxBlockInclusive: number): Promise<number> {
    const stale = await this.op('dropQuery', () =>
      [...this.matches.values()]
        .filter((m) => m.status === 'provisional' && m.chainId === chainId && m.blockNumber <= maxBlockInclusive)
        .map((m) => m.matchKey),
    )
    let dropped = 0
    for (const key of stale) {
      const changed = await this.op('dropItem', () => {
        const stored = this.matches.get(key)
        if (stored?.status !== 'provisional') return false
        this.matches.set(key, { ...stored, status: 'dropped' })
        return true
      })
      if (changed) dropped++
    }
    return dropped
  }

  withStatus(status: MatchRecord['status']): MatchRecord[] {
    return [...this.matches.values()].filter((m) => m.status === status)
  }

  private async op<T>(op: StoreOp, apply: () => T): Promise<T> {
    const crash = this.crash
    const trips = crash?.op === op && ++crash.calls === crash.at
    if (trips && crash.phase === 'before') {
      this.crash = undefined
      throw new Error('simulated crash')
    }
    const result = apply()
    if (trips) {
      this.crash = undefined
      throw new Error('simulated crash')
    }
    return result
  }
}

function fields(match: NewMatch): Omit<MatchRecord, 'status' | 'firstSeenAt' | 'finalizedAt'> {
  return {
    matchKey: match.matchKey,
    ruleId: match.ruleId,
    chainId: match.chainId,
    blockNumber: match.blockNumber,
    blockHash: match.blockHash,
    transactionHash: match.transactionHash,
    logIndex: match.logIndex,
    ordinal: match.ordinal,
    address: match.address,
    args: toStorable(match.args) as Record<string, unknown>,
  }
}

export function pingRule(ruleId: string, confirmation: RuleInput['confirmation'], minValue = 0n): StoredRule {
  return {
    ruleId,
    active: true,
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    input: ruleInputSchema.parse({
      chainId: CHAIN_ID,
      addresses: [EMITTER],
      event: PING,
      conditions: { field: 'args.value', op: 'gte', value: minValue.toString() },
      confirmation,
    }),
  }
}
