export type ActionsConfig = {
  tableName: string
  deliveryQueueUrl: string
  deliveryDlqUrl: string
  region: string
  outboundQueueUrl?: string
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

export function loadConfig(env: Env): ActionsConfig {
  const relayerApiUrl = env.RELAYER_API_URL
  const relayerApiKeyParameter = env.RELAYER_API_KEY_PARAMETER
  // half a relayer is worse than none: a rule would fail at send time instead of at deploy time
  if (relayerApiUrl && !relayerApiKeyParameter)
    throw new Error('RELAYER_API_KEY_PARAMETER is required with RELAYER_API_URL')
  if (relayerApiKeyParameter && !relayerApiUrl)
    throw new Error('RELAYER_API_URL is required with RELAYER_API_KEY_PARAMETER')

  const outboundSecretPrefixes = list(env.OUTBOUND_SECRET_PREFIXES)
  for (const prefix of outboundSecretPrefixes) {
    if (!prefix.startsWith('/')) throw new Error(`OUTBOUND_SECRET_PREFIXES entry "${prefix}" must start with /`)
  }

  return {
    tableName: required(env, 'TABLE_NAME'),
    deliveryQueueUrl: required(env, 'DELIVERY_QUEUE_URL'),
    deliveryDlqUrl: required(env, 'DELIVERY_DLQ_URL'),
    region: required(env, 'AWS_REGION'),
    ...optional('outboundQueueUrl', env.OUTBOUND_QUEUE_URL),
    ...optional('defaultWebhookSecretParameter', env.WEBHOOK_SECRET_PARAMETER),
    ...optional('telegramTokenParameter', env.TELEGRAM_TOKEN_PARAMETER),
    ...optional('fromAddress', env.SES_FROM_ADDRESS),
    ...optional('configurationSet', env.SES_CONFIGURATION_SET),
    ...optional('relayerApiUrl', relayerApiUrl),
    ...optional('relayerApiKeyParameter', relayerApiKeyParameter),
    allowedTargetArns: list(env.ALLOWED_TARGET_ARNS),
    outboundSecretPrefixes,
    reaperLimit: positive(env, 'REAPER_LIMIT') ?? 100,
  }
}

function required(env: Env, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`${key} is required`)
  return value
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

function positive(env: Env, key: string): number | undefined {
  const value = env[key]
  if (value === undefined || value === '') return undefined
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${key} must be a whole number of at least 1`)
  return n
}
