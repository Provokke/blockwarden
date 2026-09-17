import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm'
import { z } from 'zod'

const chainSchema = z
  .object({
    chainId: z.number().int().positive(),
    // one of the two: inline URLs for local runs, or an SSM SecureString holding comma-separated URLs
    rpcUrls: z.array(z.string().url()).min(1).optional(),
    rpcUrlsParameter: z.string().startsWith('/').optional(),
    confirmations: z.number().int().positive().default(5),
    stuckAfterSeconds: z.number().int().positive().default(90),
  })
  .refine((c) => (c.rpcUrls === undefined) !== (c.rpcUrlsParameter === undefined), {
    message: 'set exactly one of rpcUrls and rpcUrlsParameter',
  })

export type ChainConfig = {
  chainId: number
  rpcUrls: string[]
  confirmations: number
  stuckAfterMs: number
}

export type RelayerConfig = {
  tableName: string
  queueUrl?: string
  chains: ChainConfig[]
  // signers whose balances the sweeper reports
  signerIds: string[]
  requeueAfterMs: number
  timeBudgetMs: number
}

type Env = Record<string, string | undefined>

export async function loadConfig(env: Env, ssm: Pick<SSMClient, 'send'>): Promise<RelayerConfig> {
  const tableName = required(env, 'TABLE_NAME')
  const parsedChains = z
    .array(chainSchema)
    .min(1)
    .parse(JSON.parse(required(env, 'CHAINS')))
  const chains: ChainConfig[] = []
  for (const chain of parsedChains) {
    chains.push({
      chainId: chain.chainId,
      rpcUrls: chain.rpcUrls ?? (await fromParameter(ssm, chain.rpcUrlsParameter!)),
      confirmations: chain.confirmations,
      stuckAfterMs: chain.stuckAfterSeconds * 1000,
    })
  }
  return {
    tableName,
    ...(env.QUEUE_URL ? { queueUrl: env.QUEUE_URL } : {}),
    chains,
    signerIds: env.SIGNER_IDS
      ? env.SIGNER_IDS.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    requeueAfterMs: seconds(env, 'REQUEUE_AFTER_SECONDS', 600) * 1000,
    timeBudgetMs: seconds(env, 'TIME_BUDGET_SECONDS', 50) * 1000,
  }
}

async function fromParameter(ssm: Pick<SSMClient, 'send'>, name: string): Promise<string[]> {
  const output = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
  const urls = (output.Parameter?.Value ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  if (urls.length === 0) throw new Error(`parameter ${name} holds no RPC URLs`)
  return urls
}

function required(env: Env, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`${key} is required`)
  return value
}

function seconds(env: Env, key: string, fallback: number): number {
  const value = env[key]
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${key} must be a positive whole number of seconds`)
  return n
}
