import { readFile } from 'node:fs/promises'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { HttpRequestError } from 'viem'
import { describe, expect, it } from 'vitest'
import type { Caller } from '../../src/caller.js'
import type { HealthDeps } from '../../src/health.js'
import { createApiHandler, PUBLIC_ROUTES, ROUTES, SESSION_ONLY_ROUTES, type ApiDeps } from '../../src/routes.js'
import type { ApiStore } from '../../src/store.js'

const session: Caller = { kind: 'session', address: '0x52908400098527886E0F7030069857D2E4169EE7' }
const apiKey: Caller = { kind: 'apiKey', hash: 'a'.repeat(64), signerIds: ['demo'], label: 'ci' }

const ALL_ROUTES = Object.values(ROUTES)
const RELAYER_READ_VIEWS: string[] = [ROUTES.listSigners, ROUTES.getTx, ROUTES.listTxs]

function event(
  routeKey: string,
  caller?: Caller | string,
  extra: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 {
  const [method = 'GET', path = '/'] = routeKey.split(' ')
  const authorizer =
    caller === undefined
      ? {}
      : { authorizer: { lambda: { caller: typeof caller === 'string' ? caller : JSON.stringify(caller) } } }
  return {
    version: '2.0',
    routeKey,
    rawPath: path,
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      accountId: '123456789012',
      apiId: 'api',
      domainName: 'demo.blockwarden.dev',
      domainPrefix: 'demo',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '192.0.2.1', userAgent: 'test' },
      requestId: 'request',
      routeKey,
      stage: '$default',
      time: '24/Sep/2026:12:00:00 +0000',
      timeEpoch: 0,
      // the authorizer's context is on the proxy event only when API Gateway ran one, which the base type omits
      ...authorizer,
    } as APIGatewayProxyEventV2['requestContext'],
    ...extra,
  }
}

type Calls = string[]

// every store method records that it ran, so a refusal can be shown to have happened before any handler work
function fakeStore(calls: Calls, overrides: Partial<ApiStore> = {}): ApiStore {
  const record =
    <T>(name: string, value: T) =>
    async () => {
      calls.push(name)
      return value
    }
  return {
    put: record('put', undefined),
    consume: record('consume', false),
    getApiKey: record('getApiKey', undefined),
    putRule: record('putRule', undefined),
    getRule: record('getRule', undefined),
    deleteRule: record('deleteRule', false),
    listRules: record('listRules', { rules: [] }),
    listMatches: record('listMatches', { matches: [] }),
    listDead: record('listDead', { deliveries: [] }),
    listBySubject: record('listBySubject', { deliveries: [] }),
    getDelivery: record('getDelivery', undefined),
    requeueDelivery: record('requeueDelivery', false),
    listSigners: record('listSigners', []),
    getTx: record('getTx', undefined),
    listPendingTxs: record('listPendingTxs', { txs: [] }),
    ...overrides,
  }
}

function deps(overrides: { store?: Partial<ApiStore>; health?: Partial<HealthDeps> } = {}) {
  const calls: Calls = []
  const logged: { message: string; data?: Record<string, unknown>; level?: string }[] = []
  const store = fakeStore(calls, overrides.store)
  const log: ApiDeps['log'] = (message, data, level) => logged.push({ message, data, level })
  const built: ApiDeps = {
    siwe: {
      store,
      settings: {
        domain: 'demo.blockwarden.dev',
        origin: 'https://demo.blockwarden.dev',
        chainIds: [8453],
        allowedWallets: ['0x52908400098527886E0F7030069857D2E4169EE7'],
      },
      publicClient: () => undefined,
      secret: new TextEncoder().encode('s'.repeat(32)),
      now: () => Date.parse('2026-09-24T12:00:00Z'),
    },
    rules: { store, settings: { ruleSecretPrefixes: [], chainIds: [8453] }, now: () => '2026-09-24T12:00:00.000Z' },
    matches: { store },
    deliveries: {
      store,
      queue: {
        send: async () => {
          calls.push('queue.send')
        },
      },
      now: () => 0,
    },
    relayer: { store, chainIds: [8453] },
    health: {
      doc: {
        send: async () => {
          calls.push('health.doc')
          return {}
        },
      },
      sqs: {
        send: async () => {
          calls.push('health.sqs')
          return { Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0' } }
        },
      },
      table: 'blockwarden',
      chainIds: [8453],
      queues: { delivery: 'https://sqs.eu-west-2.amazonaws.com/123456789012/deliveries' },
      now: () => 0,
      log,
      ...overrides.health,
    },
    log,
  }
  return { handler: createApiHandler(built), calls, logged }
}

function code(body: string | undefined): string | undefined {
  return (JSON.parse(body ?? '{}') as { error?: { code?: string } }).error?.code
}

describe('createApiHandler', () => {
  it('gives every route in ROUTES a handler', async () => {
    const { handler } = deps()
    for (const routeKey of ALL_ROUTES) {
      const result = await handler(event(routeKey, session))
      // a handler's own 404 (no such rule, no such tx) is an answer; only the router's means the route is unwired
      expect(code(result.body), routeKey).not.toBe('route_not_found')
      expect(result.statusCode, routeKey).toBeLessThan(500)
    }
  })

  it('refuses a route key it does not know, including the names every object carries', async () => {
    const { handler, calls } = deps()
    for (const routeKey of ['GET /v1/secrets', 'POST /v1/relayer/txs', 'constructor', '__proto__', 'toString']) {
      const result = await handler(event(routeKey, session))
      expect(result.statusCode, routeKey).toBe(404)
      expect(code(result.body), routeKey).toBe('route_not_found')
    }
    expect(calls).toEqual([])
  })

  it('puts every route except the auth three behind the authorizer', async () => {
    const guarded = ALL_ROUTES.filter((route) => !PUBLIC_ROUTES.includes(route))
    expect(guarded).toHaveLength(ALL_ROUTES.length - 3)
    expect([...PUBLIC_ROUTES].sort()).toEqual([ROUTES.logout, ROUTES.nonce, ROUTES.verify].sort())

    const { handler, calls } = deps()
    for (const routeKey of guarded) {
      const result = await handler(event(routeKey))
      expect(result.statusCode, routeKey).toBe(401)
    }
    expect(calls).toEqual([])
  })

  it('answers a route with no caller context as unauthorized rather than crashing', async () => {
    const { handler } = deps()
    expect((await handler(event(ROUTES.listRules))).statusCode).toBe(401)
    // a context that is present but unreadable is no caller either
    expect((await handler(event(ROUTES.listRules, '{"kind":"session","address":"nope"}'))).statusCode).toBe(401)
    expect((await handler(event(ROUTES.listRules, 'not json'))).statusCode).toBe(401)
  })

  it('serves the auth routes with no caller at all', async () => {
    const { handler } = deps()
    for (const routeKey of PUBLIC_ROUTES) {
      const result = await handler(event(routeKey))
      expect(result.statusCode, routeKey).not.toBe(401)
      expect(code(result.body), routeKey).not.toBe('route_not_found')
    }
  })

  it('refuses an API key on a dashboard route before the handler runs', async () => {
    const { handler, calls } = deps()
    const result = await handler(
      event(ROUTES.createRule, apiKey, { body: JSON.stringify({ chainId: 8453 }), isBase64Encoded: false }),
    )
    expect(result.statusCode).toBe(403)
    expect(code(result.body)).toBe('session_required')
    expect(calls).toEqual([])
  })

  it("lets an API key reach the relayer's read views and nothing else", async () => {
    const { handler } = deps()
    for (const routeKey of ALL_ROUTES.filter((route) => !PUBLIC_ROUTES.includes(route))) {
      const result = await handler(event(routeKey, apiKey))
      if (RELAYER_READ_VIEWS.includes(routeKey)) {
        expect(result.statusCode, routeKey).not.toBe(403)
        expect(SESSION_ONLY_ROUTES, routeKey).not.toContain(routeKey)
      } else {
        expect(result.statusCode, routeKey).toBe(403)
        expect(SESSION_ONLY_ROUTES, routeKey).toContain(routeKey)
      }
    }
  })

  it('never puts the thrown error in the body, and logs it without the RPC URL', async () => {
    const thrown = new HttpRequestError({
      url: 'https://base.example/v2/SECRETKEY',
      status: 502,
      details: 'bad gateway',
    })
    const { handler, logged } = deps({
      store: {
        listRules: async () => {
          throw thrown
        },
      },
    })
    expect(thrown.message).toContain('SECRETKEY')
    const result = await handler(event(ROUTES.listRules, session))
    expect(result.statusCode).toBe(500)
    expect(result.body).not.toContain('https://')
    expect(result.body).not.toContain('SECRETKEY')
    expect(result.body).not.toContain('bad gateway')
    const failure = logged.find((entry) => entry.level === 'error')
    expect(failure?.data?.routeKey).toBe(ROUTES.listRules)
    expect(JSON.stringify(logged)).toContain('bad gateway')
    expect(JSON.stringify(logged)).not.toContain('SECRETKEY')
  })

  it('turns a nonce collision the store could not absorb into a bare 500', async () => {
    const collision = Object.assign(new Error('The conditional request failed'), {
      name: 'ConditionalCheckFailedException',
    })
    const { handler } = deps({
      store: {
        put: async () => {
          throw collision
        },
      },
    })
    const result = await handler(event(ROUTES.nonce))
    expect(result.statusCode).toBe(500)
    expect(result.body).not.toContain('conditional')
    expect(code(result.body)).toBe('internal')
  })

  it("passes a handler's cookies through to the response", async () => {
    const { handler } = deps()
    const result = await handler(event(ROUTES.logout))
    expect(result.statusCode).toBe(200)
    expect(result.cookies?.[0]).toMatch(/^bw_session=; /)
  })

  it('serves health to a session from the table and the queue', async () => {
    const { handler, calls } = deps()
    const result = await handler(event(ROUTES.health, session))
    expect(result.statusCode).toBe(200)
    expect(JSON.parse(result.body ?? '{}')).toEqual({
      chains: { 8453: { durableBlock: null, fastBlock: null, cursorAgeSeconds: null } },
      queues: { delivery: { visible: 0, inFlight: 0 } },
    })
    expect(calls.sort()).toEqual(['health.doc', 'health.sqs'])
  })
})

// API Gateway forwards only the routes Terraform registers, and puts the authorizer only where Terraform says: a
// route registered with no handler is a 500 on a real request, a handler with no route is dead code that reads as
// shipped, and a guarded route left public would reach its handler with no caller. This reads the file as text
// rather than parsing HCL, so it pins the shape the routes are written in as well as their values.
describe('modules/api', () => {
  const mainTf = () => readFile(new URL('../../../../infra/terraform/modules/api/main.tf', import.meta.url), 'utf8')

  it('registers in Terraform exactly the routes the service handles', async () => {
    const tf = await mainTf()
    const declared = [...tf.matchAll(/route_key\s*=\s*"([^"]+)"/g)].map((m) => m[1])
    expect(declared).toHaveLength(ALL_ROUTES.length)
    expect(new Set(declared)).toEqual(new Set(ALL_ROUTES))
  })

  it('leaves exactly the public routes without the authorizer', async () => {
    const tf = await mainTf()
    const entries = [...tf.matchAll(/route_key\s*=\s*"([^"]+)"\s*,\s*public\s*=\s*(true|false)\s*\}/g)]
    // every route_key has to be in this one-line form, or a route could be registered without being checked here
    expect(entries).toHaveLength([...tf.matchAll(/route_key\s*=\s*"/g)].length)
    const open = entries.filter((m) => m[2] === 'true').map((m) => m[1])
    expect(new Set(open)).toEqual(new Set(PUBLIC_ROUTES))

    // and the flag is what decides it, on the one route resource, which registers every entry
    const route = /resource "aws_apigatewayv2_route" "api" \{[\s\S]*?\n\}/.exec(tf)?.[0] ?? ''
    expect(route).toMatch(/for_each\s*=\s*local\.routes\n/)
    expect(route).toMatch(/authorization_type\s*=\s*each\.value\.public \? "NONE" : "CUSTOM"\n/)
    expect(route).toMatch(
      /authorizer_id\s*=\s*each\.value\.public \? null : aws_apigatewayv2_authorizer\.session\.id\n/,
    )
    expect([...tf.matchAll(/resource "aws_apigatewayv2_route"/g)]).toHaveLength(1)
  })
})
