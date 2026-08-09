import { parseAbiItem, toEventSelector, type AbiEvent, type Hex } from 'viem'
import type { Condition, RuleInput } from './rule.js'

export type ValidationIssue = { path: string; message: string }

export class RuleValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join('; '))
    this.name = 'RuleValidationError'
  }
}

export type CompiledRule = RuleInput & { ruleId: string; abiEvent: AbiEvent; topic0: Hex }

const CONTEXT_FIELDS = new Set(['address', 'blockNumber', 'transactionHash', 'logIndex'])

export function compileRule(ruleId: string, input: RuleInput): CompiledRule {
  const issues: ValidationIssue[] = []
  const abiEvent = parseEvent(input.event, issues)

  if (abiEvent) {
    const unnamed = abiEvent.inputs.findIndex((i) => !i.name)
    if (unnamed !== -1) issues.push({ path: 'event', message: `input ${unnamed} has no name` })

    const names = new Set(abiEvent.inputs.map((i) => i.name))
    for (const { path, field } of leafFields(input.conditions, 'conditions')) {
      const [head, arg] = field.split('.')
      if (head === 'args') {
        if (!arg || !names.has(arg)) issues.push({ path, message: `event has no input named "${arg ?? ''}"` })
      } else if (!CONTEXT_FIELDS.has(field)) {
        issues.push({ path, message: `unknown field "${field}"` })
      }
    }
  }

  if (issues.length > 0 || !abiEvent) throw new RuleValidationError(issues)
  return { ...input, ruleId, abiEvent, topic0: toEventSelector(abiEvent) }
}

function parseEvent(signature: string, issues: ValidationIssue[]): AbiEvent | undefined {
  let item: { type: string }
  try {
    item = parseAbiItem(signature) as unknown as { type: string }
  } catch (err) {
    issues.push({ path: 'event', message: `cannot parse event signature (${(err as Error).name})` })
    return undefined
  }
  if (item.type !== 'event') {
    issues.push({ path: 'event', message: 'expected an event signature' })
    return undefined
  }
  return item as unknown as AbiEvent
}

function* leafFields(condition: Condition | undefined, path: string): Generator<{ path: string; field: string }> {
  if (!condition) return
  if ('all' in condition) {
    for (const [i, c] of condition.all.entries()) yield* leafFields(c, `${path}.all.${i}`)
  } else if ('any' in condition) {
    for (const [i, c] of condition.any.entries()) yield* leafFields(c, `${path}.any.${i}`)
  } else {
    yield { path: `${path}.field`, field: condition.field }
  }
}
