import { describeError, hashApiKey } from '@blockwarden/core'
import type { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda'
import { authorize, type AuthorizerResult } from '../authorizer.js'
import { createAuthorizerRuntime, createLogger, once } from './runtime.js'

const logger = createLogger('blockwarden-api-authorizer')

const runtime = once(() => createAuthorizerRuntime(logger))

export async function handler(event: APIGatewayRequestAuthorizerEventV2): Promise<AuthorizerResult> {
  const r = await runtime()
  try {
    return await authorize({ secret: r.secret, now: () => Date.now(), store: r.store, hash: hashApiKey }, event)
  } catch (err) {
    // a failure to look a key up is not a verdict on it: throwing makes API Gateway answer 500, where a deny would
    // tell a valid caller their credential is bad, and with result caching on would keep telling them. Lambda
    // logs a thrown error's message and stack, so the one it sees carries nothing and the detail goes through
    // describeError
    r.log('authorization failed', { error: describeError(err) }, 'error')
    throw new Error('authorization failed')
  }
}
