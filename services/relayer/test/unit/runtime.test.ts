import type { Logger } from '@aws-lambda-powertools/logger'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEADLINE_MARGIN_MS,
  SIGNER_CALLS_PER_MESSAGE,
  SIGNER_RPC_BUDGET_MS,
  SIGNER_TIMEOUT_MS,
} from '../../src/batch.js'
import { MAX_RPC_URLS } from '../../src/config.js'
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
  it('gives the API one try per URL, with every URL hanging in turn inside the function timeout', () => {
    for (let urls = 1; urls <= 6; urls++) {
      const options = chainOptionsFor('api', urls)
      expect(options.retryCount).toBe(0)
      expect(options.timeoutMs! * urls).toBeLessThanOrEqual(15_000 - 3_000)
    }
    expect(chainOptionsFor('api', 2).timeoutMs).toBe(4_000)
  })

  it("splits the signer's RPC budget over the worst message's calls and URLs, between 1 and 2.5 seconds", () => {
    for (let urls = 1; urls <= 6; urls++) {
      const options = chainOptionsFor('signer', urls)
      expect(options.retryCount).toBe(0)
      const share = SIGNER_RPC_BUDGET_MS / (SIGNER_CALLS_PER_MESSAGE * urls)
      expect(options.timeoutMs).toBe(Math.max(1_000, Math.min(2_500, Math.floor(share))))
    }
    expect(chainOptionsFor('signer', 1).timeoutMs).toBe(2_500)
    expect(chainOptionsFor('signer', 2).timeoutMs).toBe(2_000)
    expect(chainOptionsFor('signer', 3).timeoutMs).toBe(1_333)
  })

  // a message may start with only the margin left, so the margin has to hold a whole worst-case message
  it('keeps the worst message inside the signer timeout minus the batch margin at every allowed URL count', () => {
    for (let urls = 1; urls <= MAX_RPC_URLS; urls++) {
      const worstMessageMs = SIGNER_CALLS_PER_MESSAGE * urls * chainOptionsFor('signer', urls).timeoutMs!
      expect(worstMessageMs).toBeLessThanOrEqual(SIGNER_TIMEOUT_MS - DEADLINE_MARGIN_MS)
    }
  })

  it('gives the sweeper one try per URL, splitting 20 seconds over the URLs, between 1 and 4 seconds', () => {
    expect(chainOptionsFor('sweeper', 1)).toEqual({ timeoutMs: 4_000, retryCount: 0 })
    expect(chainOptionsFor('sweeper', 5)).toEqual({ timeoutMs: 4_000, retryCount: 0 })
    expect(chainOptionsFor('sweeper', 6)).toEqual({ timeoutMs: 3_333, retryCount: 0 })
    expect(chainOptionsFor('sweeper', 30)).toEqual({ timeoutMs: 1_000, retryCount: 0 })
  })
})
