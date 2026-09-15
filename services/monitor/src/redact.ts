const MAX_CAUSE_DEPTH = 5

export function redactUrls(text: string, urls: string[]): string {
  // longest first, so a URL that is a prefix of another never leaves the rest of that key behind
  const replacements = urls
    .flatMap((url, i) => forms(url).map((form) => ({ form, label: `rpc[${i}]` })))
    .sort((a, b) => b.form.length - a.form.length)
  let redacted = text
  for (const { form, label } of replacements) redacted = redacted.split(form).join(label)
  return redacted
}

export function redactError(err: unknown, urls: string[]): { message: string; stack: string | undefined } {
  const lines = [messageOf(err)]
  let cause = (err as { cause?: unknown } | undefined)?.cause
  for (let depth = 0; cause !== undefined && depth < MAX_CAUSE_DEPTH; depth++) {
    lines.push(`caused by: ${messageOf(cause)}`)
    cause = (cause as { cause?: unknown } | undefined)?.cause
  }
  const stack = err instanceof Error ? err.stack : undefined
  return {
    message: redactUrls(lines.join('\n'), urls),
    stack: stack === undefined ? undefined : redactUrls(stack, urls),
  }
}

const MAX_DATA_DEPTH = 5
const TOO_DEEP = '[nested too deep to log]'

// log data can carry an error or a URL at any depth; past the bound it is dropped rather than logged unredacted
export function redactData(value: unknown, urls: string[], depth = 0): unknown {
  if (typeof value === 'string') return redactUrls(value, urls)
  if (value === null || typeof value !== 'object') return value
  if (depth > MAX_DATA_DEPTH) return TOO_DEEP
  if (Array.isArray(value)) return value.map((item) => redactData(item, urls, depth + 1))
  if (value instanceof Error) {
    const cause = (value as { cause?: unknown }).cause
    return {
      name: value.name,
      message: redactUrls(value.message, urls),
      ...(value.stack === undefined ? {} : { stack: redactUrls(value.stack, urls) }),
      ...(cause === undefined ? {} : { cause: redactData(cause, urls, depth + 1) }),
    }
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactData(v, urls, depth + 1)]))
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function forms(url: string): string[] {
  const all = new Set([url])
  try {
    const parsed = new URL(url)
    all.add(parsed.href)
    // viem sends credentials as a header and prints the URL without them, query key included
    const withoutCredentials = new URL(url)
    withoutCredentials.username = ''
    withoutCredentials.password = ''
    all.add(withoutCredentials.href)
    const base = `${parsed.origin}${parsed.pathname}`
    const bare = base.replace(/\/+$/, '')
    all.add(bare)
    all.add(`${bare}/`)
  } catch {
    // not a URL: the literal string is still replaced
  }
  return [...all].filter((form) => form.length > 0)
}
