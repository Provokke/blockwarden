import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'

export function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function apiError(status: number, code: string, message: string, issues?: { path: string; message: string }[]) {
  return json(status, { error: { code, message, ...(issues ? { issues } : {}) } })
}

// retries off: a refused request must show as refused now, not after the client's backoff
export function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

export type Call = { path: string; method: string; body: unknown; query: URLSearchParams }

export function parseCall(input: string, init?: RequestInit): Call {
  const url = new URL(input, 'http://localhost')
  return {
    path: url.pathname,
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    query: url.searchParams,
  }
}

// an opaque cursor over an offset, the way the API's cursors are opaque to the page
export const pageCursor = (offset: number) => Buffer.from(JSON.stringify({ offset })).toString('base64url')

export function readOffset(cursor: string | null): number | undefined {
  if (cursor === null) return 0
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown }
    return typeof parsed.offset === 'number' ? parsed.offset : undefined
  } catch {
    return undefined
  }
}

// a listing that honours limit and cursor, and refuses a cursor it did not issue; its own cap is below the
// dashboard's page size so the second page exists
export function paged<T>(rows: T[], query: URLSearchParams, field: string, cap = 2) {
  const offset = readOffset(query.get('cursor'))
  if (offset === undefined) return apiError(400, 'invalid_cursor', 'that cursor cannot be read')
  const size = Math.min(Number(query.get('limit') ?? cap), cap)
  const slice = rows.slice(offset, offset + size)
  const next = offset + size < rows.length ? pageCursor(offset + size) : undefined
  return json(200, { [field]: slice, ...(next ? { cursor: next } : {}) })
}
