import { RelayerApiError, type RelayerClientOptions, type RelayRequest } from '@blockwarden/relayer-client'
import { describe, expect, it, vi } from 'vitest'
import { sendRelay } from '../../src/senders/relay.js'
import type { DeliveryRecord } from '../../src/records.js'
import type { SenderDeps } from '../../src/senders/types.js'

const delivery = (): DeliveryRecord => ({
  deliveryId: 'dlv_relay',
  subject: 'MATCH#0xabc',
  actionId: 'a_1111111111111111',
  event: 'match.final',
  seq: 0,
  channel: 'relay',
  target: {
    channel: 'relay',
    signerId: 'demo',
    chainId: 84_532,
    to: '0x2222222222222222222222222222222222222222',
    data: '0xabcdef01',
    value: '0',
    gasLimit: '120000',
  },
  payload: '{"id":"dlv_relay"}',
  status: 'delivering',
  attempts: 1,
  createdAt: 'now',
  updatedAt: 'now',
  version: 1,
  expiresAt: 0,
})

const deps = (relay: unknown, overrides: Partial<SenderDeps> = {}): SenderDeps =>
  ({
    secrets: { read: async () => ['bw_key'] },
    now: () => 0,
    log: vi.fn(),
    relayerApiUrl: 'https://api.example.com',
    relayerApiKeyParameter: '/bw/relayer-key',
    relay,
    ...overrides,
  }) as SenderDeps

describe('sendRelay', () => {
  it('submits the action as a transaction, keyed on the delivery id', async () => {
    const relay = vi.fn(async (_options: RelayerClientOptions, _request: RelayRequest) => ({ txId: 'tx-9' }))
    expect(await sendRelay(deps(relay), delivery())).toEqual({ kind: 'delivered' })
    const [options, request] = relay.mock.calls[0]!
    expect(options).toEqual({ baseUrl: 'https://api.example.com', apiKey: 'bw_key' })
    expect(request).toEqual({
      signerId: 'demo',
      chainId: 84_532,
      to: '0x2222222222222222222222222222222222222222',
      data: '0xabcdef01',
      value: 0n,
      gasLimit: 120_000n,
      // the same key on every attempt, so a retry after a timeout returns the first transaction
      idempotencyKey: 'dlv_relay',
      reference: 'MATCH#0xabc',
    })
  })

  it('leaves value and gasLimit out when the action did not set them', async () => {
    const relay = vi.fn(async (_options: RelayerClientOptions, _request: RelayRequest) => ({ txId: 'tx-9' }))
    const d = delivery()
    const target = { ...d.target, value: undefined, gasLimit: undefined }
    await sendRelay(deps(relay), { ...d, target: target as never })
    const [, request] = relay.mock.calls[0]!
    expect(request.value).toBeUndefined()
    expect(request.gasLimit).toBeUndefined()
  })

  it('threads timeoutMs and deadlineMs into the relayer call, using whichever is tighter', async () => {
    const relay = vi.fn(async (_options: RelayerClientOptions, _request: RelayRequest) => ({ txId: 'tx-9' }))
    await sendRelay(deps(relay, { timeoutMs: 5_000 }), delivery())
    expect(relay.mock.calls[0]![0].timeoutMs).toBe(5_000)

    const relay2 = vi.fn(async (_options: RelayerClientOptions, _request: RelayRequest) => ({ txId: 'tx-9' }))
    await sendRelay(deps(relay2, { deadlineMs: 3_000 }), delivery())
    expect(relay2.mock.calls[0]![0].timeoutMs).toBe(3_000)

    const relay3 = vi.fn(async (_options: RelayerClientOptions, _request: RelayRequest) => ({ txId: 'tx-9' }))
    await sendRelay(deps(relay3, { timeoutMs: 5_000, deadlineMs: 3_000 }), delivery())
    expect(relay3.mock.calls[0]![0].timeoutMs).toBe(3_000)
  })

  // the codes services/relayer/src/api.ts and src/submit.ts really return, and the ones the client itself
  // manufactures (packages/relayer-client/src/client.ts) when the relayer never answers with a body
  const REAL_OUTCOMES: [number, string, 'retry' | 'permanent'][] = [
    // api.ts
    [404, 'not_found', 'permanent'],
    [401, 'unauthorized', 'permanent'],
    [400, 'invalid_json', 'permanent'],
    [503, 'busy', 'retry'],
    [500, 'internal', 'retry'],
    // submit.ts
    [400, 'invalid_request', 'permanent'],
    [403, 'signer_not_allowed', 'permanent'],
    [409, 'idempotency_conflict', 'permanent'],
    [404, 'signer_not_found', 'permanent'],
    [422, 'chain_not_enabled', 'permanent'],
    [422, 'policy_violation', 'permanent'],
    [422, 'dependency_not_found', 'permanent'],
    [422, 'dependency_failed', 'permanent'],
    [422, 'estimate_reverted', 'permanent'],
    [422, 'estimate_failed', 'permanent'],
    [503, 'rpc_unavailable', 'retry'],
    [422, 'spend_cap_exceeded', 'permanent'],
    // client.ts
    [0, 'network_error', 'retry'],
    [429, 'throttled', 'retry'],
    [502, 'http_error', 'retry'],
    [200, 'invalid_response', 'retry'],
  ]

  it.each(REAL_OUTCOMES)(
    'classifies %s %s as %s, matching the relayer this code really comes from',
    async (status, code, kind) => {
      const relay = async () => {
        throw new RelayerApiError(status, { code, message: code })
      }
      expect((await sendRelay(deps(relay), delivery())).kind).toBe(kind)
    },
  )

  it('treats an unknown 4xx as permanent and an unknown 5xx as a retry', async () => {
    const relay4xx = async () => {
      throw new RelayerApiError(418, { code: 'teapot', message: 'unrecognised' })
    }
    expect((await sendRelay(deps(relay4xx), delivery())).kind).toBe('permanent')

    const relay5xx = async () => {
      throw new RelayerApiError(503, { code: 'unrecognised_5xx', message: 'unrecognised' })
    }
    expect((await sendRelay(deps(relay5xx), delivery())).kind).toBe('retry')
  })

  it('retries when the relayer could not be called at all', async () => {
    const relay = async () => {
      throw new Error('fetch failed')
    }
    const outcome = await sendRelay(deps(relay), delivery())
    expect(outcome.kind).toBe('retry')
    expect(outcome.kind === 'retry' && outcome.error).toContain('the relayer could not be called')
  })

  it('fails permanently with no relayer configured, and retries a key it cannot read', async () => {
    const relay = vi.fn()
    const unset = { ...deps(relay), relayerApiUrl: undefined }
    expect((await sendRelay(unset as never, delivery())).kind).toBe('permanent')
    expect(relay).not.toHaveBeenCalled()
    const broken = {
      ...deps(relay),
      secrets: {
        read: async () => {
          throw new Error('ThrottlingException')
        },
      },
    }
    expect((await sendRelay(broken as never, delivery())).kind).toBe('retry')
  })

  it('retries a secret reader that answers with no key, the way the webhook sender does', async () => {
    const relay = vi.fn()
    const empty = deps(relay, { secrets: { read: async () => [] } })
    const outcome = await sendRelay(empty, delivery())
    expect(outcome.kind).toBe('retry')
    expect(relay).not.toHaveBeenCalled()
  })

  it('never puts the API key in an error', async () => {
    const relay = async () => {
      throw new RelayerApiError(401, { code: 'unauthorized', message: 'key bw_key is not allowed' })
    }
    const outcome = await sendRelay(deps(relay), delivery())
    expect(outcome.kind).toBe('permanent')
    expect(outcome.kind === 'permanent' && outcome.error).not.toContain('bw_key')
  })
})
