import {
  GetQueueAttributesCommand,
  type GetQueueAttributesCommandOutput,
  type QueueAttributeName,
} from '@aws-sdk/client-sqs'
import { GetCommand, type GetCommandOutput } from '@aws-sdk/lib-dynamodb'
import { describeError } from '@blockwarden/core'
import { ok, type ApiResult } from './http.js'

// What this route can honestly see is what the table and the queues already hold. Block lag would need each chain's
// head, which is an RPC call on every request to a paid endpoint; the monitor already publishes durableLag as a
// metric with an alarm behind it. cursorAgeSeconds is staleness, not lag: how long since the monitor last wrote
// the cursor. A poller that stops writes nothing, so a growing age is the signal - but a young cursor does not
// prove the monitor is keeping up with the chain, only that it is still moving.

export type ChainHealth = { durableBlock: string | null; fastBlock: string | null; cursorAgeSeconds: number | null }
export type QueueHealth = { visible: number; inFlight: number }

export type HealthBody = {
  // null where the read itself failed, so a broken half does not hide the half that answered
  chains: Record<string, ChainHealth | null>
  queues: Record<string, QueueHealth | null>
}

export type HealthDeps = {
  doc: { send(command: GetCommand): Promise<Pick<GetCommandOutput, 'Item'>> }
  sqs: { send(command: GetQueueAttributesCommand): Promise<Pick<GetQueueAttributesCommandOutput, 'Attributes'>> }
  table: string
  chainIds: number[]
  // a display name for each queue URL, since a URL is not what an operator reads on a dashboard
  queues: Record<string, string>
  now(): number
  log(message: string, data?: Record<string, unknown>, level?: 'warn' | 'error'): void
}

const DEPTH_ATTRIBUTES: QueueAttributeName[] = ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']

export async function handleHealth(deps: HealthDeps): Promise<ApiResult> {
  const [chains, queues] = await Promise.all([
    Promise.all(deps.chainIds.map(async (chainId) => [String(chainId), await chainHealth(deps, chainId)] as const)),
    Promise.all(Object.entries(deps.queues).map(async ([name, url]) => [name, await queueHealth(deps, name, url)])),
  ])
  return ok({ chains: Object.fromEntries(chains), queues: Object.fromEntries(queues) } satisfies HealthBody)
}

async function chainHealth(deps: HealthDeps, chainId: number): Promise<ChainHealth | null> {
  let item: Record<string, unknown> | undefined
  try {
    // `@blockwarden/api` has no dependency on `@blockwarden/monitor`, so this key is a copied literal of
    // services/monitor/src/keys.ts's keys.cursor; any change there must be mirrored here by hand
    const result = await deps.doc.send(
      new GetCommand({ TableName: deps.table, Key: { PK: `CHAIN#${chainId}`, SK: 'CURSOR' } }),
    )
    item = result.Item
  } catch (err) {
    deps.log('health could not read a cursor', { chainId, error: describeError(err) }, 'warn')
    return null
  }
  // a chain the monitor has not started yet: zero is a real block number, so nothing is reported rather than a
  // plausible-looking zero
  if (!item) return { durableBlock: null, fastBlock: null, cursorAgeSeconds: null }
  return {
    durableBlock: blockString(item.durableBlock),
    fastBlock: blockString(item.fastBlock),
    cursorAgeSeconds: ageSeconds(item.updatedAt, deps.now()),
  }
}

async function queueHealth(deps: HealthDeps, name: string, url: string): Promise<QueueHealth | null> {
  try {
    const result = await deps.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: DEPTH_ATTRIBUTES }),
    )
    const visible = Number(result.Attributes?.ApproximateNumberOfMessages)
    const inFlight = Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible)
    if (!Number.isFinite(visible) || !Number.isFinite(inFlight)) return null
    return { visible, inFlight }
  } catch (err) {
    deps.log('health could not read a queue', { queue: name, error: describeError(err) }, 'warn')
    return null
  }
}

// the monitor writes block numbers as DynamoDB numbers; the document client hands one back as a bigint past 2^53,
// and the wire carries a decimal string either way
function blockString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'bigint') return value.toString()
  return null
}

// services/monitor/src/store.ts's saveCursor stamps updatedAt (ISO 8601) on every write of the row
function ageSeconds(updatedAt: unknown, nowMs: number): number | null {
  if (typeof updatedAt !== 'string') return null
  const writtenMs = Date.parse(updatedAt)
  if (Number.isNaN(writtenMs)) return null
  // two clocks: a write stamped slightly ahead of this one is fresh, not negatively old
  return Math.max(0, Math.floor((nowMs - writtenMs) / 1000))
}
