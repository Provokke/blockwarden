import { Metrics } from '@aws-lambda-powertools/metrics'
import { createDispatcherHandler, realPorts } from './handlers.js'
import { createLogger, createRuntime, once } from './runtime.js'

const logger = createLogger('blockwarden-actions-dispatcher')

export const handler = createDispatcherHandler(
  once(() => createRuntime(logger)),
  realPorts,
  new Metrics({ namespace: 'Blockwarden', serviceName: 'actions' }),
)
