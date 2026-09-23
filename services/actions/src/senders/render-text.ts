import { truncate } from '../records.js'

// A person reads these. The bytes that were signed are the JSON payload; this is a rendering of it, and it is
// deliberately not parsed back by anything.
const MAX_TEXT = 4_096
// no single value gets to fill the body: a transaction carries its calldata, and the hash and the receipt
// status are what the message exists to deliver
const MAX_VALUE = 256
// a subject is one header line, and nobody reads a kilobyte of it
const MAX_SUBJECT = 200
// what a person looks for first, so a bulky field further down cannot push these off the end
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
  // a transaction that has neither status would otherwise end in an empty pair of brackets
  const subject = subjectLine(`Blockwarden: ${head} on chain ${chainId}${state ? ` (${state})` : ''}`)
  const lines = [`${type}  ${event.createdAt ?? ''}`, `delivery ${event.id ?? ''}`, '', ...describe(summaryFirst(data))]
  const text = capText(lines.join('\n'))
  const html = `<pre>${escapeHtml(text)}</pre>`
  return { subject, text, html }
}

// a caller writes one of these too, so it gets what the generated one gets: one line, and an end to it
export function subjectLine(raw: string): string {
  return truncate(raw.replace(/\s+/g, ' ').trim(), MAX_SUBJECT)
}

// stable, so everything the list does not name keeps the order the payload had
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

// a newline inside a value starts a line of its own, and a line of its own reads exactly like a field we
// rendered. Decoded arguments are chain data and a reference is caller text, so neither is ours to trust.
function oneLine(value: unknown): string {
  return truncate(String(value).replace(/[\r\n]+/g, ' '), MAX_VALUE)
}

// slice() would cut a surrogate pair in half; truncate() backs off, and its ellipsis has to fit under the cap
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
