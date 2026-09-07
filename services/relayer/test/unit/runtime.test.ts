import type { Logger } from '@aws-lambda-powertools/logger'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chainOptionsFor, createRuntime } from '../../src/lambda/runtime.js'

describe('createRuntime', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('logs failures at the level they are given, so an error filter or alarm on the log finds them', async () => {
    vi.stubEnv('TABLE_NAME', 't')
    vi.stubEnv('CHAINS', JSON.stringify([{ chainId: 1, rpcUrls: ['http://x'] }]))
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { log } = await createRuntime(logger as unknown as Logger, 'api')

    log('swept', { chainId: 1 })
    log('estimate failed', { chainId: 1 }, 'warn')
    log('message failed', undefined, 'error')

    expect(logger.info.mock.calls).toEqual([['swept', { chainId: 1 }]])
    expect(logger.warn.mock.calls).toEqual([['estimate failed', { chainId: 1 }]])
    expect(logger.error.mock.calls).toEqual([['message failed', {}]])
  })
})

describe('chainOptionsFor', () => {
  it('gives the API and signer one try per URL, with every URL hanging in turn inside the function timeout', () => {
    for (const [kind, timeoutMs] of [
      ['api', 15_000],
      ['signer', 30_000],
    ] as const) {
      for (let urls = 1; urls <= 6; urls++) {
        const options = chainOptionsFor(kind, urls)
        expect(options.retryCount).toBe(0)
        expect(options.timeoutMs! * urls).toBeLessThanOrEqual(timeoutMs - 3_000)
      }
    }
    expect(chainOptionsFor('api', 2).timeoutMs).toBe(4_000)
  })

  it('leaves the sweeper its longer settings behind its hard stop', () => {
    expect(chainOptionsFor('sweeper', 3)).toEqual({ timeoutMs: 10_000, retryCount: 1 })
  })
})
