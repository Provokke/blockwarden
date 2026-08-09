import type { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

function fakeSsm(value: string | undefined) {
  const calls: unknown[] = []
  const ssm = {
    send: async (command: GetParameterCommand) => {
      calls.push(command.input)
      return { Parameter: { Value: value } }
    },
  } as unknown as Pick<SSMClient, 'send'>
  return { ssm, calls }
}

const base = { TABLE_NAME: 'blockwarden', CHAIN_ID: '8453' }

describe('loadConfig', () => {
  it('uses RPC_URLS from the environment without calling SSM', async () => {
    const { ssm, calls } = fakeSsm('https://unused')
    const config = await loadConfig({ ...base, RPC_URLS: 'https://a, https://b ,' }, ssm)
    expect(config.rpcUrls).toEqual(['https://a', 'https://b'])
    expect(calls).toEqual([])
  })

  it('reads the URLs from an SSM SecureString otherwise', async () => {
    const { ssm, calls } = fakeSsm('https://a,https://b')
    const config = await loadConfig({ ...base, RPC_URLS_PARAMETER: '/blockwarden/rpc/base' }, ssm)
    expect(config.rpcUrls).toEqual(['https://a', 'https://b'])
    expect(calls).toEqual([{ Name: '/blockwarden/rpc/base', WithDecryption: true }])
  })

  it('applies defaults', async () => {
    const config = await loadConfig({ ...base, RPC_URLS: 'https://a' }, fakeSsm(undefined).ssm)
    expect(config).toEqual({
      tableName: 'blockwarden',
      chainId: 8453,
      rpcUrls: ['https://a'],
      maxRange: 2000,
      timeBudgetMs: 50_000,
      startBlock: undefined,
      finalityDepth: undefined,
    })
    const deep = await loadConfig({ ...base, RPC_URLS: 'https://a', FINALITY_DEPTH: '256' }, fakeSsm(undefined).ssm)
    expect(deep.finalityDepth).toBe(256)
  })

  it('rejects a missing table name and a non-integer range', async () => {
    const { ssm } = fakeSsm(undefined)
    await expect(loadConfig({ CHAIN_ID: '1', RPC_URLS: 'https://a' }, ssm)).rejects.toThrow('TABLE_NAME is required')
    await expect(loadConfig({ ...base, RPC_URLS: 'https://a', MAX_RANGE: '2k' }, ssm)).rejects.toThrow(
      'MAX_RANGE must be a non-negative integer',
    )
  })

  it('rejects a max range or a finality depth below 1', async () => {
    const { ssm } = fakeSsm(undefined)
    await expect(loadConfig({ ...base, RPC_URLS: 'https://a', MAX_RANGE: '0' }, ssm)).rejects.toThrow(
      'MAX_RANGE must be at least 1',
    )
    await expect(loadConfig({ ...base, RPC_URLS: 'https://a', FINALITY_DEPTH: '0' }, ssm)).rejects.toThrow(
      'FINALITY_DEPTH must be at least 1',
    )
    await expect(
      loadConfig({ ...base, RPC_URLS: 'https://a', MAX_RANGE: '1', FINALITY_DEPTH: '1' }, ssm),
    ).resolves.toMatchObject({ maxRange: 1, finalityDepth: 1 })
  })

  it('rejects an empty SSM parameter', async () => {
    const { ssm } = fakeSsm('')
    await expect(loadConfig({ ...base, RPC_URLS_PARAMETER: '/x' }, ssm)).rejects.toThrow('parameter /x is empty')
  })
})
