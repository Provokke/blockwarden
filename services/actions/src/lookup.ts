import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { compileRule, RuleValidationError, type ActionInput, type RuleInput } from '@blockwarden/core'
import { actionId } from './ids.js'

export type RuleAction = { actionId: string; action: ActionInput }

export type CompiledRuleView = {
  ruleId: string
  event: string
  eventName: string
  mode: RuleInput['confirmation']['mode']
  actions: RuleAction[]
}

export type SignerView = { signerId: string; webhooks: string[]; webhookSecretParameter?: string }

export type Lookup = {
  rule(ruleId: string): Promise<CompiledRuleView | undefined>
  signer(signerId: string): Promise<SignerView | undefined>
}

// A rule or a signer changes far less often than a match arrives, and a warm container would otherwise read
// the same item for every delivery. A minute is short enough that an edited rule takes effect while an operator
// is still watching, and long enough to cost nothing.
const DEFAULT_TTL_MS = 60_000

type Entry<T> = { value: T | undefined; readAt: number }

export function createLookup(
  doc: DynamoDBDocumentClient,
  tableName: string,
  options: {
    ttlMs?: number
    now?: () => number
    log?: (message: string, data?: Record<string, unknown>, level?: 'warn' | 'error') => void
  } = {},
): Lookup {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? (() => {})
  const rules = new Map<string, Entry<CompiledRuleView>>()
  const signers = new Map<string, Entry<SignerView>>()

  async function read<T>(cache: Map<string, Entry<T>>, key: string, load: () => Promise<T | undefined>) {
    const cached = cache.get(key)
    if (cached && now() - cached.readAt < ttlMs) return cached.value
    const value = await load()
    cache.set(key, { value, readAt: now() })
    return value
  }

  async function item(PK: string, SK: string): Promise<Record<string, unknown> | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: tableName, Key: { PK, SK } }))
    return Item
  }

  return {
    rule: (ruleId) =>
      read(rules, ruleId, async () => {
        const stored = await item(`RULE#${ruleId}`, 'META')
        if (!stored) return undefined
        try {
          const input = stored.input as RuleInput
          const compiled = compileRule(ruleId, input)
          return {
            ruleId,
            event: input.event,
            eventName: compiled.abiEvent.name,
            mode: input.confirmation.mode,
            actions: input.actions.map((action) => ({ actionId: actionId(action), action })),
          }
        } catch (err) {
          // the monitor skips a rule that no longer compiles and keeps polling; the dispatcher does the same
          const message = err instanceof RuleValidationError ? err.message : 'rule could not be read'
          log('rule skipped', { ruleId, error: message }, 'warn')
          return undefined
        }
      }),
    signer: (signerId) =>
      read(signers, signerId, async () => {
        const stored = await item(`SIGNER#${signerId}`, 'META')
        if (!stored) return undefined
        const webhooks = Array.isArray(stored.webhooks) ? stored.webhooks.filter((u) => typeof u === 'string') : []
        return {
          signerId,
          webhooks,
          ...(typeof stored.webhookSecretParameter === 'string'
            ? { webhookSecretParameter: stored.webhookSecretParameter }
            : {}),
        }
      }),
  }
}
