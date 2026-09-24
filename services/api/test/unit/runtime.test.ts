import { GetQueueAttributesCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs'
import { GetParameterCommand } from '@aws-sdk/client-ssm'
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiHandler, ROUTES } from '../../src/routes.js'
import {
  apiDepsFrom,
  createApiRuntime,
  createAuthorizerRuntime,
  type LoggerLike,
  type RuntimeClients,
} from '../../src/lambda/runtime.js'

const SECRET = 'x'.repeat(40)
const QUEUE = 'https://sqs.eu-west-2.amazonaws.com/123456789012/deliveries'

const env = {
  TABLE_NAME: 'blockwarden',
  SESSION_SECRET_PARAMETER: '/bw/session',
  DELIVERY_QUEUE_URL: QUEUE,
  SITE_ORIGIN: 'https://demo.blockwarden.dev',
  SIWE_DOMAIN: 'demo.blockwarden.dev',
  ALLOWED_WALLETS: '0x52908400098527886E0F7030069857D2E4169EE7',
  CHAINS: JSON.stringify([
    { chainId: 8453, rpcUrlsParameter: '/bw/rpc/base' },
    { chainId: 42161, rpcUrlsParameter: '/bw/rpc/arbitrum' },
  ]),
  RULE_SECRET_PREFIXES: '/bw/rules',
}

// answers only a parameter it holds, and only its decrypted value when asked to decrypt, as SSM does for a
// SecureString; it records every name read so a test can say which parameters a cold start touched
function fakeSsm(values: Record<string, string>) {
  const read: string[] = []
  const ssm: RuntimeClients['ssm'] = {
    async send(command) {
      if (!(command instanceof GetParameterCommand)) throw new Error('only GetParameter')
      const name = command.input.Name ?? ''
      read.push(name)
      const value = values[name]
      if (value === undefined) throw Object.assign(new Error('ParameterNotFound'), { name: 'ParameterNotFound' })
      return { Parameter: { Name: name, Value: command.input.WithDecryption === true ? value : 'AQICAHh-ciphertext' } }
    },
  }
  return { ssm, read }
}

const PARAMETERS = {
  '/bw/session': SECRET,
  '/bw/rpc/base': 'https://base.example/v2/KEY1',
  '/bw/rpc/arbitrum': 'https://arb.example/v2/KEY2,https://arb2.example/v2/KEY3',
}

function fakeLogger() {
  const lines: { level: string; message: string; data: unknown }[] = []
  const at =
    (level: string) =>
    (message: string, data?: unknown): void => {
      lines.push({ level, message, data })
    }
  const logger: LoggerLike = { info: at('info'), warn: at('warn'), error: at('error') }
  return { logger, lines }
}

// honours the table and key it is asked for: a GetItem for anything but these rows finds nothing
function fakeDoc(rows: Record<string, unknown>[], asked: unknown[]): DynamoDBDocumentClient {
  return {
    async send(command: unknown) {
      if (!(command instanceof GetCommand)) throw new Error('only GetItem')
      asked.push(command.input)
      if (command.input.TableName !== 'blockwarden') return {}
      const key = command.input.Key ?? {}
      const item = rows.find((row) => row.PK === key.PK && row.SK === key.SK)
      return item ? { Item: item } : {}
    },
  } as unknown as DynamoDBDocumentClient
}

function fakeSqs(asked: unknown[]): SQSClient {
  return {
    async send(command: unknown) {
      if (command instanceof GetQueueAttributesCommand) {
        asked.push(command.input)
        if (command.input.QueueUrl !== QUEUE) throw new Error('NonExistentQueue')
        return { Attributes: { ApproximateNumberOfMessages: '4', ApproximateNumberOfMessagesNotVisible: '1' } }
      }
      if (command instanceof SendMessageCommand) {
        asked.push(command.input)
        return {}
      }
      throw new Error('unexpected SQS command')
    },
  } as unknown as SQSClient
}

function healthEvent(): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: ROUTES.health,
    rawPath: '/v1/health',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      authorizer: {
        lambda: { caller: JSON.stringify({ kind: 'session', address: '0x52908400098527886E0F7030069857D2E4169EE7' }) },
      },
    } as unknown as APIGatewayProxyEventV2['requestContext'],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createApiRuntime', () => {
  it('reads the session secret and every chain RPC parameter, decrypted, and builds a client per chain', async () => {
    const { ssm, read } = fakeSsm(PARAMETERS)
    const { logger } = fakeLogger()
    const runtime = await createApiRuntime(logger, { env, ssm, doc: fakeDoc([], []), sqs: fakeSqs([]) })
    expect(read.sort()).toEqual(['/bw/rpc/arbitrum', '/bw/rpc/base', '/bw/session'])
    expect(runtime.secret).toEqual(new TextEncoder().encode(SECRET))
    const deps = apiDepsFrom(runtime)
    expect(deps.siwe.publicClient(8453)).toBeDefined()
    expect(deps.siwe.publicClient(42161)).toBeDefined()
    expect(deps.siwe.publicClient(1)).toBeUndefined()
    expect(deps.siwe.settings).toEqual({
      domain: 'demo.blockwarden.dev',
      origin: 'https://demo.blockwarden.dev',
      chainIds: [8453, 42161],
      allowedWallets: ['0x52908400098527886E0F7030069857D2E4169EE7'],
    })
    expect(deps.rules.settings).toEqual({ ruleSecretPrefixes: ['/bw/rules'], chainIds: [8453, 42161] })
    expect(deps.relayer.chainIds).toEqual([8453, 42161])
  })

  it('refuses a cold start whose RPC parameter holds nothing usable, naming the parameter and not the value', async () => {
    const { ssm } = fakeSsm({ ...PARAMETERS, '/bw/rpc/base': 'https://base.example/v2/SECRETKEY,not a url' })
    const { logger } = fakeLogger()
    const failure = createApiRuntime(logger, { env, ssm, doc: fakeDoc([], []), sqs: fakeSqs([]) })
    await expect(failure).rejects.toThrow('/bw/rpc/base')
    await expect(failure).rejects.not.toThrow('SECRETKEY')
  })

  it('refuses a cold start whose session secret is too short to key HS256', async () => {
    const { ssm } = fakeSsm({ ...PARAMETERS, '/bw/session': 'short' })
    const { logger } = fakeLogger()
    await expect(createApiRuntime(logger, { env, ssm, doc: fakeDoc([], []), sqs: fakeSqs([]) })).rejects.toThrow(
      '/bw/session',
    )
  })

  it('logs a malformed row through the logger it was given, never through console', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ssm } = fakeSsm(PARAMETERS)
    const { logger, lines } = fakeLogger()
    const doc = fakeDoc([{ PK: `APIKEY#${'a'.repeat(64)}`, SK: 'META', label: 'ci', signerIds: 'demo' }], [])
    const runtime = await createApiRuntime(logger, { env, ssm, doc, sqs: fakeSqs([]) })
    expect(await runtime.store.getApiKey('a'.repeat(64))).toBeUndefined()
    expect(lines).toContainEqual({ level: 'error', message: 'API key row is malformed', data: { label: 'ci' } })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('wires health to the configured table, chains and delivery queue', async () => {
    const { ssm } = fakeSsm(PARAMETERS)
    const { logger } = fakeLogger()
    const docAsked: unknown[] = []
    const sqsAsked: unknown[] = []
    const doc = fakeDoc(
      [
        {
          PK: 'CHAIN#42161',
          SK: 'CURSOR',
          durableBlock: 10,
          fastBlock: 12,
          version: 3,
          updatedAt: new Date().toISOString(),
        },
      ],
      docAsked,
    )
    const runtime = await createApiRuntime(logger, { env, ssm, doc, sqs: fakeSqs(sqsAsked) })
    const result = await createApiHandler(apiDepsFrom(runtime))(healthEvent())
    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body ?? '{}') as { chains: Record<string, unknown>; queues: unknown }
    expect(body.chains['8453']).toEqual({ durableBlock: null, fastBlock: null, cursorAgeSeconds: null })
    expect(body.chains['42161']).toMatchObject({ durableBlock: '10', fastBlock: '12' })
    expect(body.queues).toEqual({ delivery: { visible: 4, inFlight: 1 } })
    expect(sqsAsked).toEqual([
      { QueueUrl: QUEUE, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] },
    ])
  })

  it('sends a redrive to the configured delivery queue', async () => {
    const { ssm } = fakeSsm(PARAMETERS)
    const { logger } = fakeLogger()
    const sqsAsked: unknown[] = []
    const runtime = await createApiRuntime(logger, { env, ssm, doc: fakeDoc([], []), sqs: fakeSqs(sqsAsked) })
    await apiDepsFrom(runtime).deliveries.queue.send('{"subject":"MATCH#m","sk":"DELIVERY#d"}')
    expect(sqsAsked).toEqual([{ QueueUrl: QUEUE, MessageBody: '{"subject":"MATCH#m","sk":"DELIVERY#d"}' }])
  })
})

describe('createAuthorizerRuntime', () => {
  it('reads the session secret and no RPC parameter, even with CHAINS in its environment', async () => {
    const { ssm, read } = fakeSsm(PARAMETERS)
    const { logger } = fakeLogger()
    const runtime = await createAuthorizerRuntime(logger, { env, ssm, doc: fakeDoc([], []) })
    expect(read).toEqual(['/bw/session'])
    expect(runtime.secret).toEqual(new TextEncoder().encode(SECRET))
  })

  it('starts from the two settings it needs and nothing else', async () => {
    const { ssm } = fakeSsm(PARAMETERS)
    const { logger } = fakeLogger()
    const runtime = await createAuthorizerRuntime(logger, {
      env: { TABLE_NAME: 'blockwarden', SESSION_SECRET_PARAMETER: '/bw/session' },
      ssm,
      doc: fakeDoc([], []),
    })
    expect(runtime.config).toEqual({ tableName: 'blockwarden', sessionSecretParameter: '/bw/session' })
  })
})
