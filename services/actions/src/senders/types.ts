import type { LambdaClient } from '@aws-sdk/client-lambda'
import type { SESv2Client } from '@aws-sdk/client-sesv2'
import type { SQSClient } from '@aws-sdk/client-sqs'
import type { relay } from '@blockwarden/relayer-client'
import type { SecretReader } from '../secrets.js'
import type { HttpAnswer, Resolved, Resolver } from '../destination.js'
import type { DeliveryRecord, Log } from '../records.js'

export type SendOutcome =
  | { kind: 'delivered'; statusCode?: number }
  | { kind: 'retry'; error: string; statusCode?: number; afterSeconds?: number }
  | { kind: 'permanent'; error: string; statusCode?: number }

export type SenderDeps = {
  secrets: SecretReader
  now: () => number
  log: Log
  // every outbound call is injected, so a test never has to weaken the guard to reach a local server
  resolve?: (raw: string) => Promise<Resolved>
  post?: (
    target: Resolved,
    body: string,
    headers: Record<string, string>,
    options?: { timeoutMs?: number; deadlineMs?: number },
  ) => Promise<HttpAnswer>
  resolver?: Resolver
  defaultWebhookSecretParameter?: string
  timeoutMs?: number
  deadlineMs?: number
  ses?: Pick<SESv2Client, 'send'>
  fromAddress?: string
  configurationSet?: string
  telegramTokenParameter?: string
  // the real one is api.telegram.org. An override is operator configuration and still goes through the
  // destination guard, so a test that points it at a local server injects `resolve` as well
  telegramApiBase?: string
  relayerApiUrl?: string
  relayerApiKeyParameter?: string
  // injected so a test drives the published client's behaviour without an HTTP server
  relay?: typeof relay
  sqs?: Pick<SQSClient, 'send'>
  lambda?: Pick<LambdaClient, 'send'>
  // the only ARNs a rule may deliver to; the sender's IAM policy grants exactly these
  allowedTargetArns?: readonly string[]
  region?: string
}

export type Sender = (deps: SenderDeps, delivery: DeliveryRecord) => Promise<SendOutcome>
