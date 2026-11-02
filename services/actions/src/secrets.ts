import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm'

export type SecretReader = { read(name: string): Promise<string[]> }
// how many parameters are held in plaintext right now; a test reads it to see an expired one go
export type CachingSecretReader = SecretReader & { readonly held: number }

// rotation should take effect without a redeploy; five minutes is short enough and keeps call
// counts near zero
const DEFAULT_TTL_MS = 300_000

export function ssmSecrets(
  client: Pick<SSMClient, 'send'>,
  options: { ttlMs?: number; now?: () => number } = {},
): CachingSecretReader {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? (() => Date.now())
  const cache = new Map<string, { values: string[]; readAt: number }>()
  // one call per parameter at a time, since a cold container can take several deliveries at once
  const inFlight = new Map<string, Promise<string[]>>()

  async function fetchParameter(name: string): Promise<string[]> {
    const output = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
    const values = (output.Parameter?.Value ?? '')
      .split(',')
      .map((secret) => secret.trim())
      .filter(Boolean)
    // the error names the parameter, never its value
    if (values.length === 0) throw new Error(`parameter ${name} holds no secret`)
    cache.set(name, { values, readAt: now() })
    return values
  }

  return {
    get held() {
      return cache.size
    },
    async read(name) {
      // every expired entry goes, not just this one, so a secret nobody asks for doesn't sit in
      // memory
      for (const [held, entry] of cache) if (now() - entry.readAt >= ttlMs) cache.delete(held)
      const cached = cache.get(name)
      // a copy, so a caller sorting or emptying the array can't corrupt the cache
      if (cached) return [...cached.values]
      const pending = inFlight.get(name) ?? fetchParameter(name).finally(() => inFlight.delete(name))
      inFlight.set(name, pending)
      return [...(await pending)]
    },
  }
}
