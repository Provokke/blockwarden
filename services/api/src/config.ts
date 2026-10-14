import { getAddress, isAddress, type Address } from 'viem'
import { z } from 'zod'

export type ChainSetting = { chainId: number; rpcUrlsParameter: string }

export type ApiConfig = {
  tableName: string
  sessionSecretParameter: string
  deliveryQueueUrl: string
  siteOrigin: string
  siweDomain: string
  allowedWallets: Address[]
  chains: ChainSetting[]
  // derived from chains, so the list a handler checks a chain id against is the list the API holds a client for
  chainIds: number[]
  ruleSecretPrefixes: string[]
}

// the authorizer runs in front of every request, so it is given the two settings it uses and nothing that would
// let it read an RPC URL
export type AuthorizerConfig = { tableName: string; sessionSecretParameter: string }

type Env = Record<string, string | undefined>

// Every setting fails at load, which is the container's first invocation, rather than at the first request that
// happens to read it. The lesson is services/actions/src/config.ts's: OUTBOUND_SECRET_PREFIXES=/ passed its first
// validation and then admitted every parameter in the account.
const prefix = z
  .string()
  .regex(/^\/[A-Za-z0-9_.\-/]+$/, 'a prefix starts with / and is a parameter path')
  .refine((value) => value !== '/', 'a prefix of / admits every parameter')
  .refine((value) => !value.includes('..'), 'a prefix may not contain ..')

const httpsUrl = z.url().startsWith('https://', 'expected an https URL')

const chainSchema = z
  .object({ chainId: z.number().int().positive(), rpcUrlsParameter: prefix })
  // a misspelt key would otherwise be dropped without a word, leaving the chain with no RPC to verify against
  .strict()

// HS256 is keyed by the bytes of the parameter's value; a key shorter than the hash output is weaker than the MAC
const MIN_SESSION_SECRET_BYTES = 32

export function loadConfig(env: Env): ApiConfig {
  const siteOrigin = checked(env, 'SITE_ORIGIN', httpsUrl)
  if (new URL(siteOrigin).origin !== siteOrigin.replace(/\/$/, '')) {
    throw new Error(`SITE_ORIGIN: "${siteOrigin}" must be an origin, with no path, query or fragment`)
  }
  const siweDomain = required(env, 'SIWE_DOMAIN')
  // two settings that disagree make every login fail with a message about domains that names neither
  if (siweDomain !== new URL(siteOrigin).host) {
    throw new Error(`SIWE_DOMAIN "${siweDomain}" must be the host of SITE_ORIGIN "${siteOrigin}"`)
  }
  const chains = chainSettings(env)
  return {
    tableName: tableName(env),
    sessionSecretParameter: checked(env, 'SESSION_SECRET_PARAMETER', prefix),
    deliveryQueueUrl: checked(env, 'DELIVERY_QUEUE_URL', httpsUrl),
    siteOrigin: new URL(siteOrigin).origin,
    siweDomain,
    allowedWallets: allowedWallets(env),
    chains,
    chainIds: chains.map((chain) => chain.chainId),
    ruleSecretPrefixes: list(env.RULE_SECRET_PREFIXES).map((entry) => parse(prefix, entry, 'RULE_SECRET_PREFIXES')),
  }
}

export function loadAuthorizerConfig(env: Env): AuthorizerConfig {
  return {
    tableName: tableName(env),
    sessionSecretParameter: checked(env, 'SESSION_SECRET_PARAMETER', prefix),
  }
}

// the same format the monitor and the relayer read from the same parameters: a SecureString of comma-separated URLs
export function rpcUrlsFrom(parameter: string, value: string): string[] {
  const urls = list(value)
  // the URLs carry provider API keys, so both errors name the parameter and never the value
  if (urls.length === 0) throw new Error(`parameter ${parameter} holds no RPC URLs`)
  if (urls.some((url) => !z.url().safeParse(url).success)) {
    throw new Error(`parameter ${parameter} holds an invalid RPC URL`)
  }
  return urls
}

export function sessionSecretFrom(parameter: string, value: string): Uint8Array {
  const secret = new TextEncoder().encode(value)
  if (secret.length < MIN_SESSION_SECRET_BYTES) {
    throw new Error(`parameter ${parameter} must hold at least ${MIN_SESSION_SECRET_BYTES} bytes`)
  }
  return secret
}

function tableName(env: Env): string {
  return checked(env, 'TABLE_NAME', z.string().min(3, 'a DynamoDB table name is at least 3 characters'))
}

function allowedWallets(env: Env): Address[] {
  const wallets = list(env.ALLOWED_WALLETS)
  // an empty allowlist locks every operator out, which must be a refused deployment rather than a quiet state
  if (wallets.length === 0) throw new Error('ALLOWED_WALLETS must name at least one wallet')
  return wallets.map((wallet) => {
    // strict, so a mixed-case address with a broken checksum is refused as the typo it most likely is; getAddress
    // alone would quietly re-checksum it into a wallet nobody meant
    if (!isAddress(wallet)) throw new Error(`ALLOWED_WALLETS entry "${wallet}" is not an address`)
    return getAddress(wallet)
  })
}

function chainSettings(env: Env): ChainSetting[] {
  const text = required(env, 'CHAINS')
  let raw: unknown
  // JSON.parse quotes the start of its input in its error, and a URL pasted into the wrong setting would carry its key
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('CHAINS is not valid JSON')
  }
  const parsed = z.array(chainSchema).min(1, 'at least one chain is required').safeParse(raw)
  if (!parsed.success) {
    // the path and zod's message only: a value is never echoed, for the same reason as above
    const issue = parsed.error.issues[0]
    throw new Error(`CHAINS: ${issue?.path.join('.') || 'value'} ${issue?.message ?? 'is invalid'}`)
  }
  const seen = new Set<number>()
  for (const chain of parsed.data) {
    if (seen.has(chain.chainId)) throw new Error(`CHAINS lists chainId ${chain.chainId} twice`)
    seen.add(chain.chainId)
  }
  return parsed.data
}

function required(env: Env, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`${key} is required`)
  return value
}

function checked(env: Env, key: string, schema: z.ZodType<string>): string {
  return parse(schema, required(env, key), key)
}

function parse(schema: z.ZodType<string>, value: string, key: string): string {
  const result = schema.safeParse(value)
  // the setting's name and the value that failed it, so an operator can find it in the plan; none of these
  // settings holds a secret, only the name of the parameter that does
  if (!result.success) throw new Error(`${key}: "${value}" ${result.error.issues[0]?.message ?? 'is invalid'}`)
  return result.data
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}
