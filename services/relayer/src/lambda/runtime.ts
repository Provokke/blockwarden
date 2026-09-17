import { Logger } from '@aws-lambda-powertools/logger'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { SQSClient } from '@aws-sdk/client-sqs'
import { SSMClient } from '@aws-sdk/client-ssm'
import { createDocumentClient } from '@blockwarden/dynamo'
import { toKmsAccount } from '@blockwarden/kms-signer'
import type { LocalAccount } from 'viem'
import { createRelayerChain, type RelayerChain, type RelayerChainOptions } from '../chain.js'
import { loadConfig, type RelayerConfig } from '../config.js'
import { sqsTxQueue, type TxQueue } from '../queue.js'
import type { SignerRecord } from '../records.js'
import { RelayerStore } from '../store.js'

export type Runtime = {
  config: RelayerConfig
  store: RelayerStore
  chains: Map<number, RelayerChain>
  queue: TxQueue
  accountFor(signer: SignerRecord): Promise<LocalAccount>
  // info unless a level is given; failures go to warn or error so a filter on the level finds them
  log(message: string, data?: Record<string, unknown>, level?: 'warn' | 'error'): void
}

export type FunctionKind = 'api' | 'signer' | 'sweeper'

// the API's Lambda timeout set in modules/relayer/functions.tf
const API_TIMEOUT_MS = 15_000

// A hung URL holds a call for its whole timeout before the fallback moves on, and viem applies any positive timeout,
// so the 1 second floor is about real RPC latency, not the library.
// API: every URL hanging in turn fits in its timeout with 3 seconds spare.
// Signer: a cold first send makes four calls (nonce, block, tip, send), which must fit in 9 seconds so a message
// started with the batch's 12 second margin ends with time left for DynamoDB and KMS.
// Sweeper: 20 seconds a call at worst still leaves room for failover on several calls before its hard stop.
export function chainOptionsFor(kind: FunctionKind, urlCount: number): RelayerChainOptions {
  const clamp = (ms: number, max: number) => Math.max(1_000, Math.min(max, Math.floor(ms)))
  if (kind === 'api') return { timeoutMs: clamp((API_TIMEOUT_MS - 3_000) / urlCount, 4_000), retryCount: 0 }
  if (kind === 'signer') return { timeoutMs: clamp(9_000 / (4 * urlCount), 2_500), retryCount: 0 }
  return { timeoutMs: clamp(20_000 / urlCount, 4_000), retryCount: 0 }
}

export function createLogger(serviceName: string): Logger {
  return new Logger({ serviceName })
}

// Built once per warm Lambda. RPC URLs carry API keys, so logs name chains, never URLs.
export async function createRuntime(logger: Logger, kind: FunctionKind): Promise<Runtime> {
  const config = await loadConfig(process.env, new SSMClient({}))
  const endpoint = process.env.DYNAMODB_ENDPOINT
  const store = new RelayerStore(
    createDocumentClient(new DynamoDBClient(endpoint ? { endpoint } : {})),
    config.tableName,
  )
  const chains = new Map(
    config.chains.map((c) => [
      c.chainId,
      createRelayerChain(c.chainId, c.rpcUrls, chainOptionsFor(kind, c.rpcUrls.length)),
    ]),
  )
  const queue: TxQueue = config.queueUrl
    ? sqsTxQueue(new SQSClient({}), config.queueUrl)
    : {
        send: () => Promise.reject(new Error('QUEUE_URL is not set for this function')),
      }
  // one GetPublicKey per signer per container; the KMS key id comes from the signer item Terraform wrote
  const accounts = new Map<string, Promise<LocalAccount>>()
  const accountFor = (signer: SignerRecord) => {
    let account = accounts.get(signer.keyId)
    if (!account) {
      account = toKmsAccount({ keyId: signer.keyId }).catch((err: unknown) => {
        accounts.delete(signer.keyId)
        throw err
      })
      accounts.set(signer.keyId, account)
    }
    return account
  }
  return {
    config,
    store,
    chains,
    queue,
    accountFor,
    log: (message, data, level) => logger[level ?? 'info'](message, data ?? {}),
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
