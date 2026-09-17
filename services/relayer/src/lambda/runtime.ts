import { Logger } from '@aws-lambda-powertools/logger'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { SQSClient } from '@aws-sdk/client-sqs'
import { SSMClient } from '@aws-sdk/client-ssm'
import { createDocumentClient } from '@blockwarden/dynamo'
import { toKmsAccount } from '@blockwarden/kms-signer'
import type { LocalAccount } from 'viem'
import { createRelayerChain, type RelayerChain } from '../chain.js'
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
  log(message: string, data?: Record<string, unknown>): void
}

export function createLogger(serviceName: string): Logger {
  return new Logger({ serviceName })
}

// Built once per warm Lambda. RPC URLs carry API keys, so logs name chains, never URLs.
export async function createRuntime(logger: Logger): Promise<Runtime> {
  const config = await loadConfig(process.env, new SSMClient({}))
  const endpoint = process.env.DYNAMODB_ENDPOINT
  const store = new RelayerStore(
    createDocumentClient(new DynamoDBClient(endpoint ? { endpoint } : {})),
    config.tableName,
  )
  const chains = new Map(config.chains.map((c) => [c.chainId, createRelayerChain(c.chainId, c.rpcUrls)]))
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
    log: (message, data) => logger.info(message, data ?? {}),
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
