import { randomUUID } from 'node:crypto'
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { createApiHandler, type ApiHandler } from '../api.js'
import { createLogger, createRuntime, once } from './runtime.js'

const logger = createLogger('blockwarden-relayer-api')

const api = once<ApiHandler>(async () => {
  const runtime = await createRuntime(logger)
  return createApiHandler({
    store: runtime.store,
    chainFor: (chainId) => runtime.chains.get(chainId),
    addressFor: async (signer) => (await runtime.accountFor(signer)).address,
    queue: runtime.queue,
    now: () => new Date(),
    newTxId: randomUUID,
    log: runtime.log,
  })
})

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  return (await api())(event)
}
