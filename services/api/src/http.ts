import type { ApiErrorBody } from '@blockwarden/relayer-client'
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'

// API Gateway's own payload limit is 10 MB; a rule or a SIWE message is kilobytes, and parsing megabytes of
// attacker-chosen JSON on a 512 MB function is work done before anything is authenticated
const MAX_BODY_BYTES = 128 * 1024

export type ApiResult = { status: number; body: unknown; cookies?: string[] }

export type CookieOptions = { maxAgeSeconds: number; path: string }

export function error(
  status: number,
  code: string,
  message: string,
  extra: Partial<ApiErrorBody['error']> = {},
): ApiResult {
  return { status, body: { error: { code, message, ...extra } } satisfies ApiErrorBody }
}

export function ok(body: unknown, cookies?: string[]): ApiResult {
  return cookies ? { status: 200, body, cookies } : { status: 200, body }
}

export function toResponse(result: ApiResult): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: result.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(result.body),
    ...(result.cookies ? { cookies: result.cookies } : {}),
  }
}

export function readJsonBody(
  event: APIGatewayProxyEventV2,
): { ok: true; value: unknown } | { ok: false; result: ApiResult } {
  const raw = event.body
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, result: error(400, 'invalid_json', 'the request body is not JSON') }
  }
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    return { ok: false, result: error(413, 'body_too_large', 'the request body is larger than 128 KiB') }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, result: error(400, 'invalid_json', 'the request body is not JSON') }
  }
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  // Secure and HttpOnly are not options: the session token is a bearer credential, and SameSite=Strict is
  // only affordable because CloudFront serves the API and the site from one origin
  return `${name}=${value}; Path=${options.path}; Max-Age=${options.maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`
}

// narrower than APIGatewayProxyEventV2 on purpose: the authorizer event carries cookies too, and this way it
// can call readCookie without a cast, instead of only Lambda's proxy-integration event shape
export function readCookie(event: { cookies?: string[] }, name: string): string | undefined {
  for (const cookie of event.cookies ?? []) {
    const eq = cookie.indexOf('=')
    if (eq < 0) continue
    if (cookie.slice(0, eq).trim() !== name) continue
    return cookie.slice(eq + 1)
  }
  return undefined
}

export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function decodeCursor(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}
