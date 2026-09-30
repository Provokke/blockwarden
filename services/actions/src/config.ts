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
  ruleSecretPrefixes: string[]
  reaperLimit: number
}

type Env = Record<string, string | undefined>

// Everything below fails at load (the first invocation), so a Terraform typo shows up as a
// cold-start error, not one dead delivery later.

const url = z.url()
// The API key goes in a header, so no plain http.
const httpsUrl = z.url().refine((value) => value.startsWith('https://'), 'expected an https URL')

// The two services a target can name. An entry that can never match is an allowlist that grants
// nothing. Queue names follow packages/core's sqs action (max 80 chars, ".fifo" counts).
const targetArn = z
  .string()
  .regex(
    /^arn:aws[a-z-]*:(sqs:[a-z0-9-]+:\d{12}:([A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\.fifo)|lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]{1,140}(:[A-Za-z0-9_$-]+)?)$/,
    'expected an SQS queue ARN or a Lambda function ARN',
  )

export function loadConfig(env: Env): ActionsConfig {
  const relayerApiUrl = checked(env, 'RELAYER_API_URL', httpsUrl)
  const relayerApiKeyParameter = checked(env, 'RELAYER_API_KEY_PARAMETER', parameterName)
  // half a relayer is worse than none: fail at deploy time, not send time
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
    outboundSecretPrefixes: secretPrefixes(env, 'OUTBOUND_SECRET_PREFIXES'),
    ruleSecretPrefixes: secretPrefixes(env, 'RULE_SECRET_PREFIXES'),
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
  // Name the setting and the bad value so it's findable in the plan.
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

// A prefix is a parameter name with an optional trailing slash. "/" alone isn't one, it would admit
// every parameter in the account.
function secretPrefixes(env: Env, key: 'OUTBOUND_SECRET_PREFIXES' | 'RULE_SECRET_PREFIXES'): string[] {
  return list(env[key]).map((prefix) => {
    if (!prefix.startsWith('/')) throw new Error(`${key} entry "${prefix}" must start with /`)
    const named = parameterName.safeParse(prefix.replace(/\/$/, ''))
    if (!named.success) {
      throw new Error(`${key} entry "${prefix}" ${named.error.issues[0]?.message ?? 'is invalid'}`)
    }
    return prefix
  })
}

// Compare against the level separator so /billwarden doesn't admit /billwardenX. The IAM grant in
// modules/actions matches (prefix + "/" + "*").
export function underAnyPrefix(prefixes: readonly string[], name: string): boolean {
  return prefixes.some((prefix) => name.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
}

function positive(env: Env, key: string): number | undefined {
  const value = env[key]
  if (value === undefined || value === '') return undefined
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${key} must be a whole number of at least 1`)
  return n
}
