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

    for (const { path, field } of leafFields(input.conditions, 'conditions')) {
      const [head, ...rest] = field.split('.')
      if (head === 'args') {
        const message = resolveAbiPath(abiEvent.inputs, rest)
        if (message) issues.push({ path, message })
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

type AbiParameter = AbiEvent['inputs'][number]

// viem decodes a tuple as an object, so args.permission.spender is a real path; validating only the first
// segment let a typo past and the rule then matched nothing, silently
function resolveAbiPath(inputs: readonly AbiParameter[], segments: string[]): string | undefined {
  const [head, ...rest] = segments
  if (!head) return 'event has no input named ""'
  const found = inputs.find((i) => i.name === head)
  if (!found) return `event has no input named "${head}"`
  if (rest.length === 0) return undefined
  const components = (found as { components?: readonly AbiParameter[] }).components
  if (!components) return `field "${head}" is a ${found.type} and has no components`
  const [next] = rest
  const child = components.find((c) => c.name === next)
  if (!child) return `tuple "${head}" has no component named "${next ?? ''}"`
  return resolveAbiPath(components, rest)
}
