import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { createApiHandler, type ApiHandler } from '../routes.js'
import { apiDepsFrom, createApiRuntime, createLogger, once } from './runtime.js'

const logger = createLogger('blockwarden-api')

const api = once<ApiHandler>(async () => createApiHandler(apiDepsFrom(await createApiRuntime(logger))))

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  return (await api())(event)
}
