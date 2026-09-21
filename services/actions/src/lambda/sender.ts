import { Metrics } from '@aws-lambda-powertools/metrics'
import { createSenderHandler, realPorts } from './handlers.js'
import { createLogger, createRuntime, once } from './runtime.js'

const logger = createLogger('blockwarden-actions-sender')

export const handler = createSenderHandler(
  once(() => createRuntime(logger)),
  realPorts,
  new Metrics({ namespace: 'Blockwarden', serviceName: 'actions' }),
)
