import type { Hex } from 'viem'
import type { CompiledRule } from './compile.js'

export type LogFilter = { addresses: Hex[]; topic0s: Hex[] }

export function buildLogFilter(rules: CompiledRule[]): LogFilter | undefined {
  if (rules.length === 0) return undefined
  const addresses = new Set<Hex>()
  const topic0s = new Set<Hex>()
  for (const rule of rules) {
    for (const address of rule.addresses) addresses.add(address.toLowerCase() as Hex)
    topic0s.add(rule.topic0.toLowerCase() as Hex)
  }
  return { addresses: [...addresses], topic0s: [...topic0s] }
}
