import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch } from '../src/lib/api.js'

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('apiFetch', () => {
  it('sends the session cookie', async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => respond(200, { rules: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await apiFetch('/v1/rules')
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' })
  })

  it('returns the parsed body', async () => {
    vi.stubGlobal('fetch', async () => respond(200, { rules: [{ ruleId: 'r1' }] }))
    await expect(apiFetch<{ rules: unknown[] }>('/v1/rules')).resolves.toEqual({ rules: [{ ruleId: 'r1' }] })
  })

  it('throws an ApiError carrying the code the API sent', async () => {
    vi.stubGlobal('fetch', async () => respond(400, { error: { code: 'invalid_rule', message: 'no' } }))
    await expect(apiFetch('/v1/rules')).rejects.toBeInstanceOf(ApiError)
    await expect(apiFetch('/v1/rules')).rejects.toMatchObject({ code: 'invalid_rule', status: 400 })
  })

  it('carries the issues, because the rule form shows them per field', async () => {
    vi.stubGlobal('fetch', async () =>
      respond(400, { error: { code: 'invalid_rule', message: 'no', issues: [{ path: 'event', message: 'bad' }] } }),
    )
    await expect(apiFetch('/v1/rules')).rejects.toMatchObject({ issues: [{ path: 'event', message: 'bad' }] })
  })

  it('turns a 401 into an ApiError with code unauthorized, whatever the body says', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }))
    await expect(apiFetch('/v1/rules')).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
  })

  it('turns a body that is not JSON into an ApiError rather than a parse crash', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>502</html>', { status: 502 }))
    await expect(apiFetch('/v1/rules')).rejects.toMatchObject({ status: 502 })
  })

  it('sends a JSON content type only when there is a body', async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => respond(200, {}))
    vi.stubGlobal('fetch', fetchMock)
    await apiFetch('/v1/rules')
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toBeUndefined()
    await apiFetch('/v1/rules', { method: 'POST', body: { chainId: 8453 } })
    const init = fetchMock.mock.calls[1]![1] as RequestInit
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(init.body).toBe(JSON.stringify({ chainId: 8453 }))
    expect(init.method).toBe('POST')
  })

  it('returns undefined for a 204, which delete answers with', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }))
    await expect(apiFetch('/v1/rules/r1', { method: 'DELETE' })).resolves.toBeUndefined()
  })

  it('refuses a path that is not same-origin, so the cookie is never sent elsewhere', async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => respond(200, {}))
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiFetch('https://evil.example/v1/rules')).rejects.toThrow()
    await expect(apiFetch('//evil.example/v1/rules')).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
