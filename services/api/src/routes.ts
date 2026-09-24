import { describeError } from '@blockwarden/core'
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { handleLogout, handleNonce, handleVerify } from './auth-routes.js'
import { callerFromContext } from './authorizer.js'
import type { Caller } from './caller.js'
import { handleListDeliveries, handleRedrive, type DeliveryDeps } from './deliveries.js'
import { handleHealth, type HealthDeps } from './health.js'
import { error, toResponse, type ApiResult } from './http.js'
import { handleListMatches, type MatchDeps } from './matches.js'
import { handleGetTx, handleListSigners, handleListTxs, type RelayerDeps } from './relayer-routes.js'
import {
  handleCreateRule,
  handleDeleteRule,
  handleGetRule,
  handleListRules,
  handlePatchRule,
  type RuleDeps,
} from './rules.js'
import type { SiweDeps } from './siwe.js'

// the route keys the Terraform module registers; a test holds this map, the handlers and the two lists together
export const ROUTES = {
  nonce: 'POST /v1/auth/siwe/nonce',
  verify: 'POST /v1/auth/siwe/verify',
  logout: 'POST /v1/auth/logout',
  listRules: 'GET /v1/rules',
  createRule: 'POST /v1/rules',
  getRule: 'GET /v1/rules/{ruleId}',
  patchRule: 'PATCH /v1/rules/{ruleId}',
  deleteRule: 'DELETE /v1/rules/{ruleId}',
  listMatches: 'GET /v1/matches',
  listDeliveries: 'GET /v1/deliveries',
  redrive: 'POST /v1/deliveries/{deliveryId}/redrive',
  listSigners: 'GET /v1/relayer/signers',
  getTx: 'GET /v1/relayer/txs/{txId}',
  listTxs: 'GET /v1/relayer/txs',
  health: 'GET /v1/health',
} as const

export type RouteKey = (typeof ROUTES)[keyof typeof ROUTES]

const PUBLIC = [ROUTES.nonce, ROUTES.verify, ROUTES.logout] as const
type PublicRoute = (typeof PUBLIC)[number]
type GuardedRoute = Exclude<RouteKey, PublicRoute>

// the three auth routes are the only ones the authorizer does not stand in front of: a caller with no session
// cannot be asked for one
export const PUBLIC_ROUTES: readonly RouteKey[] = PUBLIC

// every other route is for an operator at a keyboard; a machine key reaches only the relayer's read views
export const SESSION_ONLY_ROUTES: readonly RouteKey[] = [
  ROUTES.listRules,
  ROUTES.createRule,
  ROUTES.getRule,
  ROUTES.patchRule,
  ROUTES.deleteRule,
  ROUTES.listMatches,
  ROUTES.listDeliveries,
  ROUTES.redrive,
  ROUTES.health,
]

export type ApiDeps = {
  siwe: SiweDeps
  rules: RuleDeps
  matches: MatchDeps
  deliveries: DeliveryDeps
  relayer: RelayerDeps
  health: HealthDeps
  log(message: string, data?: Record<string, unknown>, level?: 'warn' | 'error'): void
}

export type ApiHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>

type PublicHandler = (deps: ApiDeps, event: APIGatewayProxyEventV2) => Promise<ApiResult> | ApiResult
type GuardedHandler = (deps: ApiDeps, event: APIGatewayProxyEventV2, caller: Caller) => Promise<ApiResult>

// typed against the route unions, so a route added to ROUTES without a handler here fails to compile
const PUBLIC_HANDLERS: Record<PublicRoute, PublicHandler> = {
  [ROUTES.nonce]: (deps) => handleNonce(deps.siwe),
  [ROUTES.verify]: (deps, event) => handleVerify(deps.siwe, event),
  [ROUTES.logout]: (_deps, event) => handleLogout(event),
}

const GUARDED_HANDLERS: Record<GuardedRoute, GuardedHandler> = {
  [ROUTES.listRules]: (deps, event) => handleListRules(deps.rules, event),
  [ROUTES.createRule]: (deps, event) => handleCreateRule(deps.rules, event),
  [ROUTES.getRule]: (deps, event) => handleGetRule(deps.rules, event),
  [ROUTES.patchRule]: (deps, event) => handlePatchRule(deps.rules, event),
  [ROUTES.deleteRule]: (deps, event) => handleDeleteRule(deps.rules, event),
  [ROUTES.listMatches]: (deps, event) => handleListMatches(deps.matches, event),
  [ROUTES.listDeliveries]: (deps, event) => handleListDeliveries(deps.deliveries, event),
  [ROUTES.redrive]: (deps, event) => handleRedrive(deps.deliveries, event),
  [ROUTES.listSigners]: (deps, event, caller) => handleListSigners(deps.relayer, caller, event),
  [ROUTES.getTx]: (deps, event, caller) => handleGetTx(deps.relayer, caller, event),
  [ROUTES.listTxs]: (deps, event, caller) => handleListTxs(deps.relayer, caller, event),
  [ROUTES.health]: (deps) => handleHealth(deps.health),
}

export function createApiHandler(deps: ApiDeps): ApiHandler {
  return async (event) => {
    let result: ApiResult
    try {
      result = await route(deps, event)
    } catch (err) {
      // the body says nothing of the error: a store's message names tables and keys, and a viem error's message
      // and cause can carry the RPC URL with the provider's API key, which is also why the log gets describeError
      deps.log('request failed', { routeKey: event.routeKey, error: describeError(err) }, 'error')
      result = error(500, 'internal', 'the API failed to handle the request')
    }
    return toResponse(result)
  }
}

async function route(deps: ApiDeps, event: APIGatewayProxyEventV2): Promise<ApiResult> {
  const key = event.routeKey
  // own keys only: a route key of "constructor" must not find Object.prototype's
  if (Object.hasOwn(PUBLIC_HANDLERS, key)) return PUBLIC_HANDLERS[key as PublicRoute](deps, event)
  if (!Object.hasOwn(GUARDED_HANDLERS, key)) return error(404, 'route_not_found', 'no such route')
  const guarded = key as GuardedRoute

  // API Gateway runs the authorizer before any of these routes, so a missing or unreadable caller means the route
  // reached this function some other way; it is refused, never served as nobody in particular
  const caller = callerFromContext(event)
  if (!caller) return error(401, 'unauthorized', 'a session or an API key is required')
  if (SESSION_ONLY_ROUTES.includes(guarded) && caller.kind !== 'session') {
    return error(403, 'session_required', 'this route needs a dashboard session, not an API key')
  }
  return GUARDED_HANDLERS[guarded](deps, event, caller)
}
