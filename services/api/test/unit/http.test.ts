import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { describe, expect, it } from 'vitest'
import {
  decodeCursor,
  encodeCursor,
  error,
  ok,
  readCookie,
  readJsonBody,
  serializeCookie,
  toResponse,
} from '../../src/http.js'

function event(over: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return { version: '2.0', routeKey: 'GET /v1/health', rawPath: '/v1/health', headers: {}, ...over } as never
}

describe('error and ok', () => {
  it('shapes an error the same way the relayer does', () => {
    expect(error(404, 'not_found', 'no such route')).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'no such route' } },
    })
  })

  it('carries issues when they are given', () => {
    const result = error(400, 'invalid_rule', 'the rule does not compile', {
      issues: [{ path: 'actions.0.url', message: 'expected an https URL' }],
    })
    expect(result.body).toEqual({
      error: {
        code: 'invalid_rule',
        message: 'the rule does not compile',
        issues: [{ path: 'actions.0.url', message: 'expected an https URL' }],
      },
    })
  })

  it('returns 200 with no cookies by default', () => {
    expect(ok({ rules: [] })).toEqual({ status: 200, body: { rules: [] } })
  })
})

describe('toResponse', () => {
  it('never lets a response be cached, and says it is JSON', () => {
    const response = toResponse(ok({ ok: true }))
    expect(response.statusCode).toBe(200)
    expect(response.headers).toEqual({ 'content-type': 'application/json', 'cache-control': 'no-store' })
    expect(response.body).toBe('{"ok":true}')
    expect(response.cookies).toBeUndefined()
  })

  it('passes cookies through as the payload format wants them', () => {
    const response = toResponse({ status: 204, body: {}, cookies: ['bw_session=x; HttpOnly'] })
    expect(response.cookies).toEqual(['bw_session=x; HttpOnly'])
  })
})

describe('readJsonBody', () => {
  it('reads a plain body', () => {
    expect(readJsonBody(event({ body: '{"a":1}' }))).toEqual({ ok: true, value: { a: 1 } })
  })

  it('reads a base64 body, which is what API Gateway sends for a compressed request', () => {
    const body = Buffer.from('{"a":2}').toString('base64')
    expect(readJsonBody(event({ body, isBase64Encoded: true }))).toEqual({ ok: true, value: { a: 2 } })
  })

  it('refuses a body that is not JSON, rather than throwing', () => {
    const outcome = readJsonBody(event({ body: 'not json' }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.result.status).toBe(400)
    expect((outcome.result.body as { error: { code: string } }).error.code).toBe('invalid_json')
  })

  it('refuses a missing body, which JSON.parse would read as the string undefined', () => {
    const outcome = readJsonBody(event({}))
    expect(outcome.ok).toBe(false)
  })

  it('refuses a body larger than the cap without parsing it', () => {
    const outcome = readJsonBody(event({ body: JSON.stringify({ pad: 'x'.repeat(200_000) }) }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect((outcome.result.body as { error: { code: string } }).error.code).toBe('body_too_large')
  })
})

describe('cookies', () => {
  it('writes the attributes a session cookie must have', () => {
    const value = serializeCookie('bw_session', 'abc', { maxAgeSeconds: 43_200, path: '/' })
    expect(value).toBe('bw_session=abc; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict')
  })

  it('writes an expiry in the past when it is clearing the cookie', () => {
    const value = serializeCookie('bw_session', '', { maxAgeSeconds: 0, path: '/' })
    expect(value).toBe('bw_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict')
  })

  it('reads one cookie out of the header, ignoring the others', () => {
    const e = event({ cookies: ['other=1', 'bw_session=abc', 'trailing=2'] })
    expect(readCookie(e, 'bw_session')).toBe('abc')
    expect(readCookie(e, 'absent')).toBeUndefined()
  })

  it('does not match a cookie whose name merely ends with the one asked for', () => {
    const e = event({ cookies: ['not_bw_session=wrong'] })
    expect(readCookie(e, 'bw_session')).toBeUndefined()
  })
})

describe('cursors', () => {
  it('round-trips a cursor', () => {
    const cursor = encodeCursor({ PK: 'RULE#r1', SK: 'META' })
    expect(typeof cursor).toBe('string')
    expect(decodeCursor(cursor)).toEqual({ PK: 'RULE#r1', SK: 'META' })
  })

  it('is url-safe, because it travels in a query string', () => {
    const cursor = encodeCursor({ PK: 'MATCH#8453/0xff+/1', SK: 'META' })
    expect(cursor).toBe(encodeURIComponent(cursor))
  })

  it('returns undefined for a cursor that was tampered with, rather than throwing', () => {
    expect(decodeCursor('not-a-cursor')).toBeUndefined()
    expect(decodeCursor('')).toBeUndefined()
  })

  it('returns undefined for JSON that is not an object', () => {
    expect(decodeCursor(Buffer.from('[1,2]').toString('base64url'))).toBeUndefined()
  })
})
