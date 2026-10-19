export type ApiIssue = { path: string; message: string }

// the envelope services/api/src/http.ts writes; declared here rather than imported so the browser bundle
// takes no dependency on server packages
type ErrorEnvelope = { code: string; message: string; issues?: ApiIssue[] }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: ApiIssue[],
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export type ApiInit = { method?: string; body?: unknown }

// Paths are relative on purpose: the origin is whatever served the page, which is what keeps the session
// cookie same-site. An absolute URL would send it (credentials: 'include') somewhere else.
export async function apiFetch<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error(`apiFetch takes a same-origin path, got ${path}`)

  const hasBody = init.body !== undefined
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'include',
    ...(hasBody ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
  })

  if (res.ok) {
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  // the authorizer answers 401 before the API's own envelope exists, so the body may be empty or not ours
  if (res.status === 401) {
    const sent = await readError(res)
    throw new ApiError(401, 'unauthorized', sent?.message ?? 'sign in required')
  }
  const sent = await readError(res)
  if (!sent) throw new ApiError(res.status, 'bad_response', `the API answered ${res.status} with an unreadable body`)
  throw new ApiError(res.status, sent.code, sent.message, sent.issues)
}

async function readError(res: Response): Promise<ErrorEnvelope | undefined> {
  try {
    const body: unknown = await res.json()
    if (typeof body !== 'object' || body === null || !('error' in body)) return undefined
    const { error } = body as { error: Partial<ErrorEnvelope> }
    if (typeof error?.code !== 'string' || typeof error.message !== 'string') return undefined
    return error as ErrorEnvelope
  } catch {
    return undefined
  }
}
