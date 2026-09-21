import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { MonitorStore } from '../../../monitor/src/store.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleCreateRule, handleDeleteRule, handleListRules, handlePatchRule } from '../../src/rules.js'
import { createStore, type ApiStore } from '../../src/store.js'

let dynamo: Dynamo
let store: ApiStore
let table: string
let monitor: MonitorStore
const settings = { ruleSecretPrefixes: ['/bw/rules/'], chainIds: [8453, 42161] }
const deps = () => ({ store, settings, now: () => '2026-09-21T00:00:00.000Z' })

beforeAll(async () => {
  dynamo = await startDynamo()
  table = await dynamo.newTable()
  store = createStore({ doc: dynamo.doc, table })
  monitor = new MonitorStore(dynamo.doc, table)
}, 180_000)

afterAll(async () => {
  await dynamo?.stop()
})

// the one cast in this file, narrowed to the real event type rather than to `never` - a call site that gets
// the shape wrong (a misspelled pathParameters, say) fails to compile instead of silently passing
function apiEvent(over: Partial<APIGatewayProxyEventV2>): APIGatewayProxyEventV2 {
  return { version: '2.0', headers: {}, ...over } as APIGatewayProxyEventV2
}

function body(over: Record<string, unknown> = {}) {
  return apiEvent({
    routeKey: 'POST /v1/rules',
    body: JSON.stringify({
      chainId: 8453,
      addresses: ['0x4200000000000000000000000000000000000006'],
      event: 'event Transfer(address indexed from, address indexed to, uint256 value)',
      confirmation: { mode: 'finalized' },
      actions: [{ type: 'webhook', url: 'https://example.com/hook' }],
      ...over,
    }),
  })
}

describe('rules through the API and back through the monitor', () => {
  it('writes a rule the monitor polls', async () => {
    const created = await handleCreateRule(deps(), body())
    expect(created.status).toBe(201)
    const { ruleId } = created.body as { ruleId: string }
    const polled = await monitor.listActiveRules(8453)
    expect(polled.map((rule) => rule.ruleId)).toContain(ruleId)
  })

  it('takes a rule out of the poll when it is deactivated, and puts it back', async () => {
    const created = await handleCreateRule(deps(), body())
    const { ruleId } = created.body as { ruleId: string }
    const patch = apiEvent({
      routeKey: 'PATCH /v1/rules/{ruleId}',
      pathParameters: { ruleId },
      body: JSON.stringify({
        chainId: 8453,
        addresses: ['0x4200000000000000000000000000000000000006'],
        event: 'event Transfer(address indexed from, address indexed to, uint256 value)',
        confirmation: { mode: 'finalized' },
        actions: [{ type: 'webhook', url: 'https://example.com/hook' }],
        active: false,
      }),
    })
    await handlePatchRule(deps(), patch)
    expect((await monitor.listActiveRules(8453)).map((r) => r.ruleId)).not.toContain(ruleId)

    const on = JSON.parse(patch.body!)
    on.active = true
    await handlePatchRule(deps(), { ...patch, body: JSON.stringify(on) })
    expect((await monitor.listActiveRules(8453)).map((r) => r.ruleId)).toContain(ruleId)
  })

  it('reads active from the patch body, not from ruleInputSchema, and never lets it into the stored input', async () => {
    // ruleInputSchema is a plain z.object, so an unknown key like `active` is stripped rather than refused -
    // this proves the strip never lets `active` end up inside the row's `input`, only in the top-level field
    const created = await handleCreateRule(deps(), body())
    const { ruleId } = created.body as { ruleId: string }
    const patched = await handlePatchRule(
      deps(),
      apiEvent({
        routeKey: 'PATCH /v1/rules/{ruleId}',
        pathParameters: { ruleId },
        body: JSON.stringify({
          chainId: 8453,
          addresses: ['0x4200000000000000000000000000000000000006'],
          event: 'event Transfer(address indexed from, address indexed to, uint256 value)',
          confirmation: { mode: 'finalized' },
          actions: [{ type: 'webhook', url: 'https://example.com/hook' }],
          active: false,
        }),
      }),
    )
    expect((patched.body as { active: boolean }).active).toBe(false)
    const stored = await store.getRule(ruleId)
    expect(stored?.active).toBe(false)
    expect(stored?.input).not.toHaveProperty('active')
  })

  it('stops polling a deleted rule', async () => {
    const created = await handleCreateRule(deps(), body())
    const { ruleId } = created.body as { ruleId: string }
    const result = await handleDeleteRule(
      deps(),
      apiEvent({ routeKey: 'DELETE /v1/rules/{ruleId}', pathParameters: { ruleId } }),
    )
    expect(result.status).toBe(204)
    expect((await monitor.listActiveRules(8453)).map((r) => r.ruleId)).not.toContain(ruleId)
  })

  it('reports a delete of a rule that was never there as missing, not as done', async () => {
    const result = await handleDeleteRule(
      deps(),
      apiEvent({ routeKey: 'DELETE /v1/rules/{ruleId}', pathParameters: { ruleId: 'never-existed' } }),
    )
    expect(result.status).toBe(404)
  })

  it('pages the list, and the cursor resumes where the page ended', async () => {
    for (let i = 0; i < 5; i++) await handleCreateRule(deps(), body())
    const list = (query: Record<string, string>) =>
      handleListRules(deps(), apiEvent({ routeKey: 'GET /v1/rules', queryStringParameters: query }))

    const first = await list({ chainId: '8453', limit: '2' })
    const firstBody = first.body as { rules: { ruleId: string }[]; cursor?: string }
    expect(firstBody.rules).toHaveLength(2)
    expect(firstBody.cursor).toBeDefined()

    const second = await list({ chainId: '8453', limit: '2', cursor: firstBody.cursor! })
    const secondBody = second.body as { rules: { ruleId: string }[] }
    expect(secondBody.rules).toHaveLength(2)
    const seen = new Set([...firstBody.rules, ...secondBody.rules].map((r) => r.ruleId))
    expect(seen.size).toBe(4)
  })

  it('lists across every monitored chain when no chain is named', async () => {
    await handleCreateRule(deps(), body({ chainId: 42161 }))
    const result = await handleListRules(deps(), apiEvent({ routeKey: 'GET /v1/rules', queryStringParameters: {} }))
    const chains = new Set(((result.body as { rules: { chainId: number }[] }).rules ?? []).map((r) => r.chainId))
    expect(chains.has(8453)).toBe(true)
    expect(chains.has(42161)).toBe(true)
  })
})
