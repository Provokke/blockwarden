import { parameterName } from '@blockwarden/core'
import { z } from 'zod'

export type ActionsConfig = {
  tableName: string
  deliveryQueueUrl: string
  deliveryDlqUrl: string
  region: string
  defaultWebhookSecretParameter?: string
  telegramTokenParameter?: string
  fromAddress?: string
  configurationSet?: string
  relayerApiUrl?: string
  relayerApiKeyParameter?: string
  allowedTargetArns: string[]
  outboundSecretPrefixes: string[]
  reaperLimit: number
}

type Env = Record<string, string | undefined>

// Everything below fails at load, which is the container's first invocation, rather than at the first delivery
// that happens to read the setting: a typo in Terraform should surface as a cold-start error on every
// invocation, not as one dead delivery an hour later.

const url = z.url()

// The two services a delivery target can name. The sender refuses anything else when it sends, but an entry
// that can never match is an allowlist that silently grants nothing. The queue name takes the same shape as
// packages/core's sqs action: at most 80 characters, ".fifo" counting towards them.
const targetArn = z
  .string()
  .regex(
    /^arn:aws[a-z-]*:(sqs:[a-z0-9-]+:\d{12}:([A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\.fifo)|lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]{1,140}(:[A-Za-z0-9_$-]+)?)$/,
    'expected an SQS queue ARN or a Lambda function ARN',
  )

export function loadConfig(env: Env): ActionsConfig {
  const relayerApiUrl = checked(env, 'RELAYER_API_URL', url)
  const relayerApiKeyParameter = checked(env, 'RELAYER_API_KEY_PARAMETER', parameterName)
  // half a relayer is worse than none: a rule would fail at send time instead of at deploy time
  if (relayerApiUrl && !relayerApiKeyParameter)
    throw new Error('RELAYER_API_KEY_PARAMETER is required with RELAYER_API_URL')
  if (relayerApiKeyParameter && !relayerApiUrl)
    throw new Error('RELAYER_API_URL is required with RELAYER_API_KEY_PARAMETER')

  return {
    tableName: required(env, 'TABLE_NAME'),
    deliveryQueueUrl: requiredChecked(env, 'DELIVERY_QUEUE_URL', url),
    deliveryDlqUrl: requiredChecked(env, 'DELIVERY_DLQ_URL', url),
    region: required(env, 'AWS_REGION'),
    ...optional('defaultWebhookSecretParameter', checked(env, 'WEBHOOK_SECRET_PARAMETER', parameterName)),
    ...optional('telegramTokenParameter', checked(env, 'TELEGRAM_TOKEN_PARAMETER', parameterName)),
    ...optional('fromAddress', env.SES_FROM_ADDRESS),
    ...optional('configurationSet', env.SES_CONFIGURATION_SET),
    ...optional('relayerApiUrl', relayerApiUrl),
    ...optional('relayerApiKeyParameter', relayerApiKeyParameter),
    allowedTargetArns: checkedList(env, 'ALLOWED_TARGET_ARNS', targetArn),
    outboundSecretPrefixes: secretPrefixes(env),
    reaperLimit: positive(env, 'REAPER_LIMIT') ?? 100,
  }
}

function required(env: Env, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`${key} is required`)
  return value
}

function checked<T>(env: Env, key: string, schema: z.ZodType<T>): T | undefined {
  const value = env[key]
  if (value === undefined || value === '') return undefined
  return parse(schema, value, key)
}

function requiredChecked<T>(env: Env, key: string, schema: z.ZodType<T>): T {
  return parse(schema, required(env, key), key)
}

function parse<T>(schema: z.ZodType<T>, value: string, key: string): T {
  const result = schema.safeParse(value)
  // the name of the setting and the value that failed it, so an operator can find it in the plan
  if (!result.success) throw new Error(`${key}: "${value}" ${result.error.issues[0]?.message ?? 'is invalid'}`)
  return result.data
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Record<K, string>) : {}
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function checkedList(env: Env, key: string, schema: z.ZodType<string>): string[] {
  return list(env[key]).map((entry) => parse(schema, entry, key))
}

// A prefix names a level of the hierarchy, so it is a parameter name with an optional trailing slash. "/" alone
// is not a prefix: outbound.ts would then admit every parameter in the account, which is the outbound secret
// guard switched off by one character in Terraform.
function secretPrefixes(env: Env): string[] {
  return list(env.OUTBOUND_SECRET_PREFIXES).map((prefix) => {
    if (!prefix.startsWith('/')) throw new Error(`OUTBOUND_SECRET_PREFIXES entry "${prefix}" must start with /`)
    const named = parameterName.safeParse(prefix.replace(/\/$/, ''))
    if (!named.success) {
      throw new Error(`OUTBOUND_SECRET_PREFIXES entry "${prefix}" ${named.error.issues[0]?.message ?? 'is invalid'}`)
    }
    return prefix
  })
}

function positive(env: Env, key: string): number | undefined {
  const value = env[key]
  if (value === undefined || value === '') return undefined
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${key} must be a whole number of at least 1`)
  return n
}
