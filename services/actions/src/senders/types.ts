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
}

export type Sender = (deps: SenderDeps, delivery: DeliveryRecord) => Promise<SendOutcome>
