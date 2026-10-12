import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import type { Hex } from 'viem'
import { parseSiweMessage, verifySiweMessage } from 'viem/siwe'
import { z } from 'zod'
import { error, ok, readJsonBody, type ApiResult } from './http.js'
import { clearedSessionCookie, mintSession, sessionCookie } from './session.js'
import { checkSiweMessage, issueNonce, type SiweDeps } from './siwe.js'

const verifyBody = z.object({ message: z.string().min(1).max(4096), signature: z.string().min(1).max(4096) })

export async function handleNonce(deps: SiweDeps): Promise<ApiResult> {
  return ok({ nonce: await issueNonce(deps.store, deps.now()) })
}

export async function handleVerify(deps: SiweDeps, event: APIGatewayProxyEventV2): Promise<ApiResult> {
  const body = readJsonBody(event)
  if (!body.ok) return body.result
  const parsed = verifyBody.safeParse(body.value)
  if (!parsed.success) return error(400, 'invalid_request', 'message and signature are required')

  const message = parseSiweMessage(parsed.data.message)
  const nowMs = deps.now()
  const checked = checkSiweMessage(message, deps.settings, nowMs)
  // a malformed body is a client error; every other refusal is a real message this deployment just won't accept
  if (!checked.ok) return error(checked.code === 'siwe_malformed' ? 400 : 401, checked.code, checked.message)

  const client = deps.publicClient(checked.chainId)
  if (!client) return error(401, 'siwe_chain', 'the message names another chain')

  // the nonce is spent before the signature is checked: a wrong signature must not leave the nonce usable
  // for another attempt, or an attacker gets unlimited tries against one issued nonce
  if (!(await deps.store.consume(checked.nonce, nowMs))) {
    return error(401, 'siwe_nonce', 'that nonce is unknown, spent or expired')
  }

  // verifySiweMessage covers a contract wallet through EIP-1271, which needs the chain's client
  const valid = await verifySiweMessage(client, {
    message: parsed.data.message,
    signature: parsed.data.signature as Hex,
    domain: deps.settings.domain,
    nonce: checked.nonce,
    time: new Date(nowMs),
  })
  if (!valid) return error(401, 'siwe_signature', 'the signature does not match the message')

  const token = await mintSession(deps.secret, checked.address, nowMs)
  return ok({ address: checked.address }, [sessionCookie(token)])
}

export function handleLogout(_event: APIGatewayProxyEventV2): ApiResult {
  // clearing is unconditional: a caller with no session has nothing to lose, and refusing would only tell
  // an unauthenticated caller whether their cookie was still good
  return { status: 200, body: { ok: true }, cookies: [clearedSessionCookie()] }
}
