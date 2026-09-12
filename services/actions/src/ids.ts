import { createHash } from 'node:crypto'

// a rule may be written with its keys in any order, and an action's id has to survive that
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
  return `{${entries.join(',')}}`
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
