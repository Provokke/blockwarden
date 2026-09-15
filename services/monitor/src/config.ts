import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'

export type MonitorConfig = {
  tableName: string
  chainId: number
  rpcUrls: string[]
  maxRange: number
  timeBudgetMs: number
  startBlock?: number
  finalityDepth?: number
}

type Env = Record<string, string | undefined>

export async function loadConfig(env: Env, ssm: Pick<SSMClient, 'send'> = new SSMClient({})): Promise<MonitorConfig> {
  const tableName = required(env, 'TABLE_NAME')
  const chainId = integer(env, 'CHAIN_ID')
  if (chainId === undefined) throw new Error('CHAIN_ID is required')
  const rpcUrls = env.RPC_URLS ? splitUrls(env.RPC_URLS) : await fromParameter(ssm, required(env, 'RPC_URLS_PARAMETER'))
  if (rpcUrls.length === 0) throw new Error('no RPC URLs configured')

  return {
    tableName,
    chainId,
    rpcUrls,
    maxRange: positive(env, 'MAX_RANGE') ?? 2000,
    timeBudgetMs: integer(env, 'TIME_BUDGET_MS') ?? 50_000,
    startBlock: integer(env, 'START_BLOCK'),
    finalityDepth: positive(env, 'FINALITY_DEPTH'),
  }
}

// a zero range never advances the scan, and a zero depth would treat the head as final
function positive(env: Env, key: string): number | undefined {
  const n = integer(env, key)
  if (n !== undefined && n < 1) throw new Error(`${key} must be at least 1`)
  return n
}

async function fromParameter(ssm: Pick<SSMClient, 'send'>, name: string): Promise<string[]> {
  const output = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
  const value = output.Parameter?.Value
  if (!value) throw new Error(`parameter ${name} is empty`)
  return splitUrls(value)
}

function splitUrls(value: string): string[] {
  return value
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
}

function required(env: Env, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`${key} is required`)
  return value
}

function integer(env: Env, key: string): number | undefined {
  const value = env[key]
  if (value === undefined || value === '') return undefined
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer`)
  return n
}
