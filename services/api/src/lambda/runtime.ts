import { Logger } from '@aws-lambda-powertools/logger'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { SQSClient } from '@aws-sdk/client-sqs'
import { GetParameterCommand, SSMClient, type GetParameterCommandOutput } from '@aws-sdk/client-ssm'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createDocumentClient } from '@blockwarden/dynamo'
import { loadAuthorizerConfig, sessionSecretFrom, type AuthorizerConfig } from '../config.js'
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

export type AuthorizerRuntime = { config: AuthorizerConfig; store: ApiStore; secret: Uint8Array; log: Log }

export function createLogger(serviceName: string): Logger {
  return new Logger({ serviceName })
}

export function logTo(logger: LoggerLike): Log {
  return (message, data, level) => logger[level ?? 'info'](message, data ?? {})
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

export function documentClient(): DynamoDBDocumentClient {
  const endpoint = process.env.DYNAMODB_ENDPOINT
  return createDocumentClient(new DynamoDBClient(endpoint ? { endpoint } : {}))
}

export async function readParameter(ssm: RuntimeClients['ssm'], name: string): Promise<string> {
  const output = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
  const value = output.Parameter?.Value
  if (!value) throw new Error(`parameter ${name} has no value`)
  return value
}
