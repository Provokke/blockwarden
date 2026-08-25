import type { SignersBody } from '@blockwarden/relayer-client'
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { toTxBody, type ApiKeyRecord } from './records.js'
import { StoreBusyError } from './store.js'
import { error, hashApiKey, submitTx, type ApiResult, type SubmitDeps } from './submit.js'

// the route keys the Terraform module registers; a test holds the two lists together
export const ROUTES = {
  submit: 'POST /v1/relayer/txs',
  getTx: 'GET /v1/relayer/txs/{txId}',
  signers: 'GET /v1/relayer/signers',
} as const

export type ApiHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>

export function createApiHandler(deps: SubmitDeps): ApiHandler {
  return async (event) => {
    let result: ApiResult
    try {
      result = await route(deps, event)
    } catch (err) {
      deps.log('request failed', {
        routeKey: event.routeKey,
        error: err instanceof Error ? err.message : String(err),
        cause: err,
      })
      result =
        err instanceof StoreBusyError
          ? error(503, 'busy', 'the relayer is busy; retry the request with the same idempotency key')
          : error(500, 'internal', 'the relayer failed to handle the request')
    }
    return {
      statusCode: result.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(result.body),
    }
  }
}

async function authenticate(deps: SubmitDeps, event: APIGatewayProxyEventV2): Promise<ApiKeyRecord | undefined> {
  // API Gateway lowercases header names in the version 2.0 payload; the scheme itself is case-insensitive (RFC 7235)
  const match = /^Bearer (\S+)$/i.exec(event.headers.authorization ?? '')
  if (!match) return undefined
  return deps.store.getApiKey(hashApiKey(match[1]!))
}

async function route(deps: SubmitDeps, event: APIGatewayProxyEventV2): Promise<ApiResult> {
  if (!Object.values(ROUTES).includes(event.routeKey as never)) return error(404, 'not_found', 'no such route')
  const apiKey = await authenticate(deps, event)
  if (!apiKey) return error(401, 'unauthorized', 'a valid API key is required')

  switch (event.routeKey) {
    case ROUTES.submit: {
      let body: unknown
      try {
        const text = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body
        body = JSON.parse(text ?? '')
      } catch {
        return error(400, 'invalid_json', 'the request body is not JSON')
      }
      return submitTx(deps, apiKey, body)
    }
    case ROUTES.getTx: {
      const tx = await deps.store.getTx(event.pathParameters?.txId ?? '')
      // a transaction of a signer this key may not use reads as missing, so ids cannot be probed
      if (!tx || !apiKey.signerIds.includes(tx.signerId))
        return error(404, 'tx_not_found', 'no transaction has that id')
      return { status: 200, body: toTxBody(tx) }
    }
    default: {
      const signers: SignersBody['signers'] = []
      for (const signerId of apiKey.signerIds) {
        const signer = await deps.store.getSigner(signerId)
        if (signer) signers.push({ signerId, address: await deps.addressFor(signer), chainIds: signer.chainIds })
      }
      return { status: 200, body: { signers } satisfies SignersBody }
    }
  }
}
