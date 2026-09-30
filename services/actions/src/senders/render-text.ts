import { truncate } from '../records.js'

// A person reads these. The signed bytes are the JSON payload; this is just a rendering and nothing
// parses it back.
const MAX_TEXT = 4_096
// no single value gets to fill the body: a tx carries its calldata, but the hash and receipt status
// are the point
const MAX_VALUE = 256
// a subject is one header line, nobody reads a kilobyte of it
const MAX_SUBJECT = 200
// what a person looks for first, so a bulky field further down can't push these off the end
const SUMMARY_FIRST = [
  'eventName',
  'status',
  'receiptStatus',
  'chainId',
  'transactionHash',
  'hash',
  'blockNumber',
  'txId',
  'address',
  'reference',
]

export function summarise(payload: string): { subject: string; text: string; html: string } {
  const event = safeParse(payload)
  const data = (event.data ?? {}) as Record<string, unknown>
  const type = typeof event.type === 'string' ? event.type : 'event'
  const chainId = data.chainId ?? 'unknown'
  const head = type.startsWith('match.') ? `${data.eventName ?? 'event'}` : type
  const state = String((type.startsWith('match.') ? (data.status ?? type) : (data.receiptStatus ?? data.status)) ?? '')
  // a tx with neither status would otherwise end in an empty pair of brackets
  const subject = subjectLine(`Blockwarden: ${head} on chain ${chainId}${state ? ` (${state})` : ''}`)
  const lines = [`${type}  ${event.createdAt ?? ''}`, `delivery ${event.id ?? ''}`, '', ...describe(summaryFirst(data))]
  const text = capText(lines.join('\n'))
  const html = `<pre>${escapeHtml(text)}</pre>`
  return { subject, text, html }
}

// a caller writes one of these too, so it gets one line and an end to it
export function subjectLine(raw: string): string {
  return truncate(raw.replace(/\s+/g, ' ').trim(), MAX_SUBJECT)
}

// stable, so anything the list doesn't name keeps the payload's order
function summaryFirst(data: unknown): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data
  const rank = (key: string) => (SUMMARY_FIRST.includes(key) ? SUMMARY_FIRST.indexOf(key) : SUMMARY_FIRST.length)
  return Object.fromEntries(Object.entries(data).sort(([a], [b]) => rank(a) - rank(b)))
}

function describe(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [`${prefix}${oneLine(value)}`]
  if (Array.isArray(value)) return value.flatMap((v, i) => describe(v, `${prefix}[${i}] `))
  return Object.entries(value).flatMap(([key, v]) =>
    v !== null && typeof v === 'object'
      ? describe(v, `${prefix}${oneLine(key)}.`)
      : [`${prefix}${oneLine(key)}: ${oneLine(v)}`],
  )
}

// a newline inside a value starts a line that reads exactly like a field we rendered. Decoded args
// are chain data and a reference is caller text, so don't trust either.
function oneLine(value: unknown): string {
  return truncate(String(value).replace(/[\r\n]+/g, ' '), MAX_VALUE)
}

// slice() would cut a surrogate pair; truncate() backs off, and its ellipsis has to fit under the
// cap
function capText(text: string): string {
  return text.length <= MAX_TEXT ? text : truncate(text, MAX_TEXT - 3)
}

function safeParse(payload: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { data: payload }
  } catch {
    return { data: payload }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
