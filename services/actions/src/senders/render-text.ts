// A person reads these. The bytes that were signed are the JSON payload; this is a rendering of it, and it is
// deliberately not parsed back by anything.
const MAX_TEXT = 4_096

export function summarise(payload: string): { subject: string; text: string; html: string } {
  const event = safeParse(payload)
  const data = (event.data ?? {}) as Record<string, unknown>
  const type = typeof event.type === 'string' ? event.type : 'event'
  const chainId = data.chainId ?? 'unknown'
  const tail = type.startsWith('match.')
    ? `${data.eventName ?? 'event'} on chain ${chainId} (${data.status ?? type})`
    : `${type} on chain ${chainId} (${data.receiptStatus ?? data.status ?? ''})`
  const subject = `Blockwarden: ${tail}`.replace(/\s+/g, ' ').trim()
  const lines = [`${type}  ${event.createdAt ?? ''}`, `delivery ${event.id ?? ''}`, '', ...describe(data)]
  const text = lines.join('\n').slice(0, MAX_TEXT)
  const html = `<pre>${escapeHtml(text)}</pre>`
  return { subject, text, html }
}

function describe(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [`${prefix}${String(value)}`]
  if (Array.isArray(value)) return value.flatMap((v, i) => describe(v, `${prefix}[${i}] `))
  return Object.entries(value).flatMap(([key, v]) =>
    v !== null && typeof v === 'object' ? describe(v, `${prefix}${key}.`) : [`${prefix}${key}: ${String(v)}`],
  )
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
