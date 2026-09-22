import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm'

export type SecretReader = { read(name: string): Promise<string[]> }

// a rotation should take effect without a redeploy, and five minutes is short enough for that while keeping
// the call count near zero
const DEFAULT_TTL_MS = 300_000

export function ssmSecrets(
  client: Pick<SSMClient, 'send'>,
  options: { ttlMs?: number; now?: () => number } = {},
): SecretReader {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? (() => Date.now())
  const cache = new Map<string, { values: string[]; readAt: number }>()
  return {
    async read(name) {
      const cached = cache.get(name)
      if (cached && now() - cached.readAt < ttlMs) return cached.values
      const output = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
      const values = (output.Parameter?.Value ?? '')
        .split(',')
        .map((secret) => secret.trim())
        .filter(Boolean)
      // the error names the parameter and never its value
      if (values.length === 0) throw new Error(`parameter ${name} holds no secret`)
      cache.set(name, { values, readAt: now() })
      return values
    },
  }
}
