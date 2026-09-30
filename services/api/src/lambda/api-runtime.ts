import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { SSMClient } from '@aws-sdk/client-ssm'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import { loadConfig, rpcUrlsFrom, sessionSecretFrom, type ApiConfig } from '../config.js'
import type { ApiDeps } from '../routes.js'
import { createStore, type ApiStore } from '../store.js'
import { documentClient, logTo, readParameter, type Log, type LoggerLike, type RuntimeClients } from './runtime.js'

// The SQS client lives here, not in runtime.ts, so the authorizer's bundle does not carry it.

export type ApiRuntime = {
  config: ApiConfig
  store: ApiStore
  doc: DynamoDBDocumentClient
  sqs: SQSClient
  secret: Uint8Array
  publicClients: Map<number, PublicClient>
  log: Log
}

// Only a contract wallet's login reaches the RPC: handleVerify recovers an EOA's signature locally first. A login is
// a person waiting, so each URL gets one try and the fallback moves on; the worst case is one timeout per URL.
const RPC_TIMEOUT_MS = 3_000

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
    relayer: { store },
    health: {
      doc: runtime.doc,
      sqs: runtime.sqs,
      table: config.tableName,
      chainIds: config.chainIds,
      queues: {
        delivery: config.deliveryQueueUrl,
        deadLetter: config.deliveryDlqUrl,
        streamFailure: config.streamFailureQueueUrl,
      },
      now: nowMs,
      log,
    },
    log,
  }
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
