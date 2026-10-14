import { Logger } from '@aws-lambda-powertools/logger'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { GetParameterCommand, SSMClient, type GetParameterCommandOutput } from '@aws-sdk/client-ssm'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createDocumentClient } from '@blockwarden/dynamo'
import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import {
  loadAuthorizerConfig,
  loadConfig,
  rpcUrlsFrom,
  sessionSecretFrom,
  type ApiConfig,
  type AuthorizerConfig,
} from '../config.js'
import type { ApiDeps } from '../routes.js'
import { createStore, type ApiStore } from '../store.js'

export type Log = (message: string, data?: Record<string, unknown>, level?: 'warn' | 'error') => void

// the three levels this code logs at, as Powertools' Logger takes them; narrower so a test can hand in its own
type LogLevelFn = (message: string, data: Record<string, unknown>) => void
export type LoggerLike = { info: LogLevelFn; warn: LogLevelFn; error: LogLevelFn }

// the clients a cold start builds for itself; a test hands in its own
export type RuntimeClients = {
  env: Record<string, string | undefined>
  ssm: { send(command: GetParameterCommand): Promise<Pick<GetParameterCommandOutput, 'Parameter'>> }
  doc: DynamoDBDocumentClient
  sqs: SQSClient
}

export type ApiRuntime = {
  config: ApiConfig
  store: ApiStore
  doc: DynamoDBDocumentClient
  sqs: SQSClient
  secret: Uint8Array
  publicClients: Map<number, PublicClient>
  log: Log
}

export type AuthorizerRuntime = { config: AuthorizerConfig; store: ApiStore; secret: Uint8Array; log: Log }

// Only a contract wallet's login reaches the RPC: handleVerify recovers an EOA's signature locally first. A login is
// a person waiting, so each URL gets one try and the fallback moves on; the worst case is one timeout per URL.
const RPC_TIMEOUT_MS = 3_000

export function createLogger(serviceName: string): Logger {
  return new Logger({ serviceName })
}

export function logTo(logger: LoggerLike): Log {
  return (message, data, level) => logger[level ?? 'info'](message, data ?? {})
}

// Built once per warm Lambda. RPC URLs carry provider API keys, so they are read here, handed to viem and never
// logged; a parameter that holds a bad one fails the cold start naming the parameter only.
export async function createApiRuntime(logger: LoggerLike, clients: Partial<RuntimeClients> = {}): Promise<ApiRuntime> {
  const config = loadConfig(clients.env ?? process.env)
  const log = logTo(logger)
  const ssm = clients.ssm ?? new SSMClient({})
  const doc = clients.doc ?? documentClient()
  const [secret, chains] = await Promise.all([
    readParameter(ssm, config.sessionSecretParameter).then((value) =>
      sessionSecretFrom(config.sessionSecretParameter, value),
    ),
    Promise.all(
      config.chains.map(async (chain) => {
        const urls = rpcUrlsFrom(chain.rpcUrlsParameter, await readParameter(ssm, chain.rpcUrlsParameter))
        return [chain.chainId, publicClientFor(urls)] as const
      }),
    ),
  ])
  return {
    config,
    store: createStore({ doc, table: config.tableName, log }),
    doc,
    sqs: clients.sqs ?? new SQSClient({}),
    secret,
    publicClients: new Map(chains),
    log,
  }
}

// the authorizer stands in front of every request and needs only the session secret and the key rows; it never
// reads an RPC parameter, so its role need not be allowed to
export async function createAuthorizerRuntime(
  logger: LoggerLike,
  clients: Partial<Omit<RuntimeClients, 'sqs'>> = {},
): Promise<AuthorizerRuntime> {
  const config = loadAuthorizerConfig(clients.env ?? process.env)
  const log = logTo(logger)
  const ssm = clients.ssm ?? new SSMClient({})
  const doc = clients.doc ?? documentClient()
  const secret = sessionSecretFrom(
    config.sessionSecretParameter,
    await readParameter(ssm, config.sessionSecretParameter),
  )
  return { config, store: createStore({ doc, table: config.tableName, log }), secret, log }
}

export function apiDepsFrom(runtime: ApiRuntime): ApiDeps {
  const { config, store, log } = runtime
  const nowMs = () => Date.now()
  return {
    siwe: {
      store,
      settings: {
        domain: config.siweDomain,
        origin: config.siteOrigin,
        chainIds: config.chainIds,
        allowedWallets: config.allowedWallets,
      },
      publicClient: (chainId) => runtime.publicClients.get(chainId),
      secret: runtime.secret,
      now: nowMs,
    },
    rules: {
      store,
      settings: { ruleSecretPrefixes: config.ruleSecretPrefixes, chainIds: config.chainIds },
      now: () => new Date().toISOString(),
    },
    matches: { store },
    deliveries: {
      store,
      queue: {
        async send(body) {
          await runtime.sqs.send(new SendMessageCommand({ QueueUrl: config.deliveryQueueUrl, MessageBody: body }))
        },
      },
      now: nowMs,
    },
    relayer: { store, chainIds: config.chainIds },
    health: {
      doc: runtime.doc,
      sqs: runtime.sqs,
      table: config.tableName,
      chainIds: config.chainIds,
      queues: { delivery: config.deliveryQueueUrl },
      now: nowMs,
      log,
    },
    log,
  }
}

export function once<T>(build: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined
  return () => {
    value ??= build().catch((err: unknown) => {
      value = undefined
      throw err
    })
    return value
  }
}

function documentClient(): DynamoDBDocumentClient {
  const endpoint = process.env.DYNAMODB_ENDPOINT
  return createDocumentClient(new DynamoDBClient(endpoint ? { endpoint } : {}))
}

async function readParameter(ssm: RuntimeClients['ssm'], name: string): Promise<string> {
  const output = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
  const value = output.Parameter?.Value
  if (!value) throw new Error(`parameter ${name} has no value`)
  return value
}

function publicClientFor(rpcUrls: string[]): PublicClient {
  return createPublicClient({
    transport: fallback(
      rpcUrls.map((url) => http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 0 })),
      { retryCount: 0 },
    ),
    // the same setting as the monitor's and relayer's clients: nothing read through this client is served from cache
    cacheTime: 0,
  })
}
