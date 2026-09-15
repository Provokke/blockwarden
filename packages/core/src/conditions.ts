import type { Condition, Scalar } from './rule.js'

type Ordering = 'gt' | 'gte' | 'lt' | 'lte'

export function evaluate(condition: Condition | undefined, ctx: Record<string, unknown>): boolean {
  if (condition === undefined) return true
  if ('all' in condition) return condition.all.every((c) => evaluate(c, ctx))
  if ('any' in condition) return condition.any.some((c) => evaluate(c, ctx))

  const actual = resolveField(ctx, condition.field)
  if (actual === undefined) return false
  const { op, value } = condition
  switch (op) {
    case 'eq':
      return !Array.isArray(value) && equals(actual, value)
    case 'neq':
      return !Array.isArray(value) && !equals(actual, value)
    case 'in':
      return Array.isArray(value) && value.some((v) => equals(actual, v))
    case 'contains':
      if (Array.isArray(value)) return false
      if (Array.isArray(actual)) return actual.some((a) => equals(a, value))
      return typeof actual === 'string' && actual.toLowerCase().includes(String(value).toLowerCase())
    default:
      return compare(actual, value, op)
  }
}

export function resolveField(ctx: Record<string, unknown>, path: string): unknown {
  let current: unknown = ctx
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function toBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : undefined
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  return undefined
}

function equals(actual: unknown, expected: Scalar): boolean {
  if (typeof actual === 'bigint' || typeof actual === 'number') {
    const a = toBigInt(actual)
    const e = toBigInt(expected)
    return a !== undefined && e !== undefined && a === e
  }
  if (typeof actual === 'boolean') return actual === expected || String(actual) === expected
  if (typeof actual === 'string' && typeof expected === 'string') {
    return /^0x[0-9a-fA-F]*$/.test(actual) ? actual.toLowerCase() === expected.toLowerCase() : actual === expected
  }
  return false
}

function compare(actual: unknown, expected: Scalar | Scalar[], op: Ordering): boolean {
  if (Array.isArray(expected) || (typeof actual !== 'bigint' && typeof actual !== 'number')) return false
  const a = toBigInt(actual)
  const e = toBigInt(expected)
  if (a === undefined || e === undefined) return false
  switch (op) {
    case 'gt':
      return a > e
    case 'gte':
      return a >= e
    case 'lt':
      return a < e
    case 'lte':
      return a <= e
  }
}
