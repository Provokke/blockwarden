import { createHash } from 'node:crypto'

// an API key is stored only as this digest, so a leaked table cannot be replayed against the API
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex')
}
