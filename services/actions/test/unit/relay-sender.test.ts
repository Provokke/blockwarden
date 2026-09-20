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

const deps = (relay: unknown): SenderDeps =>
  ({
    secrets: { read: async () => ['bw_key'] },
    now: () => 0,
    log: vi.fn(),
    relayerApiUrl: 'https://api.example.com',
    relayerApiKeyParameter: '/bw/relayer-key',
    relay,
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

  it('retries a network failure, a throttle and a busy relayer', async () => {
    for (const code of ['network_error', 'throttled', 'busy', 'rpc_unavailable']) {
      const relay = async () => {
        throw new RelayerApiError(0, { code, message: code })
      }
      expect((await sendRelay(deps(relay), delivery())).kind, code).toBe('retry')
    }
  })

  it('does not retry a refusal the relayer will repeat', async () => {
    for (const code of [
      'estimate_reverted',
      'policy_violation',
      'spend_cap_exceeded',
      'invalid_request',
      'unauthorized',
      'idempotency_conflict',
    ]) {
      const relay = async () => {
        throw new RelayerApiError(422, { code, message: code })
      }
      expect((await sendRelay(deps(relay), delivery())).kind, code).toBe('permanent')
    }
  })

  it('retries a 5xx that carries no relayer code', async () => {
    const relay = async () => {
      throw new RelayerApiError(502, { code: 'http_error', message: 'bad gateway' })
    }
    expect((await sendRelay(deps(relay), delivery())).kind).toBe('retry')
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

  it('never puts the API key in an error', async () => {
    const relay = async () => {
      throw new RelayerApiError(401, { code: 'unauthorized', message: 'key bw_key is not allowed' })
    }
    const outcome = await sendRelay(deps(relay), delivery())
    expect(outcome.kind).toBe('permanent')
    expect(outcome.kind === 'permanent' && outcome.error).not.toContain('bw_key')
  })
})
