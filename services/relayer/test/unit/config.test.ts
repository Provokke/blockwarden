import { GetParameterCommand } from '@aws-sdk/client-ssm'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

function fakeSsm(values: Record<string, string>) {
  const names: string[] = []
  return {
    names,
    ssm: {
      send: (async (command: GetParameterCommand) => {
        names.push(command.input.Name!)
        expect(command.input.WithDecryption).toBe(true)
        return { Parameter: { Value: values[command.input.Name!] } }
      }) as never,
    },
  }
}

describe('loadConfig', () => {
  it('applies defaults and reads RPC URLs inline or from SSM', async () => {
    const { ssm, names } = fakeSsm({ '/rpc/base-sepolia': 'https://a.example , https://b.example' })
    const config = await loadConfig(
      {
        TABLE_NAME: 'blockwarden',
        QUEUE_URL: 'https://sqs.example/q.fifo',
        SIGNER_IDS: 'billing, paymaster',
        CHAINS: JSON.stringify([
          { chainId: 84532, rpcUrlsParameter: '/rpc/base-sepolia' },
          { chainId: 421614, rpcUrls: ['http://localhost:8545'], confirmations: 2, stuckAfterSeconds: 30 },
        ]),
      },
      ssm,
    )
    expect(config).toEqual({
      tableName: 'blockwarden',
      queueUrl: 'https://sqs.example/q.fifo',
      signerIds: ['billing', 'paymaster'],
      chains: [
        { chainId: 84532, rpcUrls: ['https://a.example', 'https://b.example'], confirmations: 5, stuckAfterMs: 90_000 },
        { chainId: 421614, rpcUrls: ['http://localhost:8545'], confirmations: 2, stuckAfterMs: 30_000 },
      ],
      requeueAfterMs: 600_000,
      timeBudgetMs: 50_000,
    })
    expect(names).toEqual(['/rpc/base-sepolia'])
  })

  it('refuses a missing table, a chain with both or neither URL source, and an empty parameter', async () => {
    const { ssm } = fakeSsm({ '/empty': ' , ' })
    const chains = (c: unknown[]) => JSON.stringify(c)
    await expect(loadConfig({ CHAINS: chains([{ chainId: 1, rpcUrls: ['http://x'] }]) }, ssm)).rejects.toThrow(
      /TABLE_NAME/,
    )
    await expect(
      loadConfig(
        { TABLE_NAME: 't', CHAINS: chains([{ chainId: 1, rpcUrls: ['http://x'], rpcUrlsParameter: '/p' }]) },
        ssm,
      ),
    ).rejects.toThrow(/exactly one/)
    await expect(loadConfig({ TABLE_NAME: 't', CHAINS: chains([{ chainId: 1 }]) }, ssm)).rejects.toThrow(/exactly one/)
    await expect(
      loadConfig({ TABLE_NAME: 't', CHAINS: chains([{ chainId: 1, rpcUrlsParameter: '/empty' }]) }, ssm),
    ).rejects.toThrow(/no RPC URLs/)
  })

  it('refuses a non-positive time setting', async () => {
    const { ssm } = fakeSsm({})
    const env = { TABLE_NAME: 't', CHAINS: JSON.stringify([{ chainId: 1, rpcUrls: ['http://x'] }]) }
    await expect(loadConfig({ ...env, REQUEUE_AFTER_SECONDS: '0' }, ssm)).rejects.toThrow(/REQUEUE_AFTER_SECONDS/)
    expect((await loadConfig({ ...env, TIME_BUDGET_SECONDS: '20' }, ssm)).timeBudgetMs).toBe(20_000)
  })
})
