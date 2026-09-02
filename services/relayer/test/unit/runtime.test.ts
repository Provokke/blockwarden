import type { Logger } from '@aws-lambda-powertools/logger'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntime } from '../../src/lambda/runtime.js'

describe('createRuntime', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('logs failures at the level they are given, so an error filter or alarm on the log finds them', async () => {
    vi.stubEnv('TABLE_NAME', 't')
    vi.stubEnv('CHAINS', JSON.stringify([{ chainId: 1, rpcUrls: ['http://x'] }]))
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { log } = await createRuntime(logger as unknown as Logger)

    log('swept', { chainId: 1 })
    log('estimate failed', { chainId: 1 }, 'warn')
    log('message failed', undefined, 'error')

    expect(logger.info.mock.calls).toEqual([['swept', { chainId: 1 }]])
    expect(logger.warn.mock.calls).toEqual([['estimate failed', { chainId: 1 }]])
    expect(logger.error.mock.calls).toEqual([['message failed', {}]])
  })
})
