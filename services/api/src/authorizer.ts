import type { APIGatewayProxyEventV2, APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda'
import { isAddress } from 'viem'
import { readCookie } from './http.js'
import { SESSION_COOKIE, verifySession } from './session.js'
import type { Caller } from './caller.js'

export { isDashboard, mayUseSigner, type Caller } from './caller.js'

export type ApiKeyRecord = { hash: string; signerIds: string[]; label: string }

export type AuthorizerDeps = {
  secret: Uint8Array
  now(): number
  store: { getApiKey(hash: string): Promise<ApiKeyRecord | undefined> }
  hash(apiKey: string): string
}

export type AuthorizerResult = { isAuthorized: boolean; context?: Record<string, unknown> }

export async function authorize(
  deps: AuthorizerDeps,
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<AuthorizerResult> {
  const cookie = readCookie(event, SESSION_COOKIE)
  if (cookie !== undefined) {
    // a cookie that is present and bad is a refusal, never a fall-through to another credential: a stale
    // browser session must not borrow the authority of a key that happens to be on the same request
    const session = await verifySession(deps.secret, cookie, deps.now())
    if (!session) return { isAuthorized: false }
    return allow({ kind: 'session', address: session.address })
  }

  const match = /^Bearer (\S+)$/i.exec(event.headers?.authorization ?? '')
  if (!match) return { isAuthorized: false }
  const record = await deps.store.getApiKey(deps.hash(match[1]!))
  if (!record) return { isAuthorized: false }
  return allow({ kind: 'apiKey', hash: record.hash, signerIds: record.signerIds, label: record.label })
}

function allow(caller: Caller): AuthorizerResult {
  // the context travels to the route Lambda and into its logs; it carries who, never the credential itself
  return { isAuthorized: true, context: { caller: JSON.stringify(caller) } }
}

export function callerFromContext(event: APIGatewayProxyEventV2): Caller | undefined {
  const raw = (event.requestContext as { authorizer?: { lambda?: { caller?: unknown } } }).authorizer?.lambda?.caller
  if (typeof raw !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const caller = parsed as Partial<Caller> & { kind?: string }
  if (caller.kind === 'session') {
    return typeof caller.address === 'string' && isAddress(caller.address)
      ? { kind: 'session', address: caller.address }
      : undefined
  }
  if (caller.kind === 'apiKey') {
    const { hash, signerIds, label } = caller as { hash?: unknown; signerIds?: unknown; label?: unknown }
    if (typeof hash !== 'string' || typeof label !== 'string') return undefined
    if (!Array.isArray(signerIds) || signerIds.some((id) => typeof id !== 'string')) return undefined
    return { kind: 'apiKey', hash, signerIds: signerIds as string[], label }
  }
  return undefined
}
