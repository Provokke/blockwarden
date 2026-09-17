import { decodeEventLog, type Hex } from 'viem'
import type { CompiledRule } from './compile.js'
import { evaluate } from './conditions.js'
import type { RawLog } from './types.js'

export type LogMatch = { rule: CompiledRule; args: Record<string, unknown>; log: RawLog }
export type KeyedMatch = LogMatch & { ordinal: number }

// a provider can return one log twice; the copy would take the next ordinal and become a record of its own
export function dedupeLogs(logs: RawLog[]): RawLog[] {
  const seen = new Set<string>()
  return logs.filter((log) => {
    const key = `${log.blockHash.toLowerCase()}#${log.logIndex}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function assignOrdinals(matches: LogMatch[]): KeyedMatch[] {
  const ordinals: number[] = []
  const counts = new Map<string, number>()
  const order = matches
    .map((_, i) => i)
    .sort((a, b) => {
      const x = matches[a]!.log
      const y = matches[b]!.log
      return x.blockNumber - y.blockNumber || x.logIndex - y.logIndex
    })
  for (const i of order) {
    const { log, rule } = matches[i]!
    const group = `${log.transactionHash.toLowerCase()}#${rule.ruleId}`
    const ordinal = counts.get(group) ?? 0
    counts.set(group, ordinal + 1)
    ordinals[i] = ordinal
  }
  return matches.map((match, i) => ({ ...match, ordinal: ordinals[i]! }))
}

export function matchLog(rules: CompiledRule[], log: RawLog): LogMatch[] {
  const topic0 = log.topics[0]?.toLowerCase()
  const address = log.address.toLowerCase()
  const matches: LogMatch[] = []

  for (const rule of rules) {
    if (rule.topic0.toLowerCase() !== topic0) continue
    if (!rule.addresses.some((a) => a.toLowerCase() === address)) continue

    let args: Record<string, unknown>
    try {
      const decoded = decodeEventLog({
        abi: [rule.abiEvent],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      })
      args = (decoded.args ?? {}) as Record<string, unknown>
    } catch {
      continue
    }

    const ctx = {
      args,
      address: log.address,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
    }
    if (evaluate(rule.conditions, ctx)) matches.push({ rule, args, log })
  }
  return matches
}
