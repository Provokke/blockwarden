import { createHash } from 'node:crypto'

// a rule may be written with its keys in any order, and an action's id has to survive that
export function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value, '<root>', new Set())
}

function hasToJSON(value: unknown): value is { toJSON: (key: string) => unknown } {
  return value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>).toJSON === 'function'
}

// walks the value the way JSON.stringify does: call toJSON before looking at the shape, so a Date (or anything
// else with a toJSON) canonicalises to what JSON.stringify would actually send over the wire, not `{}`
function canonicalJsonValue(value: unknown, at: string, seen: Set<unknown>): string {
  const normalised = hasToJSON(value) ? value.toJSON(at) : value

  if (typeof normalised === 'bigint') {
    throw new TypeError(`canonicalJson: cannot serialise a bigint (at ${at})`)
  }
  if (normalised === null || typeof normalised !== 'object') return JSON.stringify(normalised) ?? 'null'

  if (seen.has(normalised)) {
    throw new TypeError(`canonicalJson: cannot serialise a cyclic object (at ${at})`)
  }
  seen.add(normalised)
  try {
    if (Array.isArray(normalised)) {
      return `[${normalised.map((v, i) => canonicalJsonValue(v, String(i), seen)).join(',')}]`
    }
    const entries = Object.entries(normalised as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonValue(v, k, seen)}`)
    return `{${entries.join(',')}}`
  } finally {
    seen.delete(normalised)
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function actionId(action: unknown): string {
  return `a_${sha256Hex(canonicalJson(action)).slice(0, 16)}`
}

// the newline cannot appear in either half, so no pair of different halves gives the same input
export function deliveryId(subject: string, sk: string): string {
  return `dlv_${sha256Hex(`${subject}\n${sk}`).slice(0, 32)}`
}
