import type { DeliveryRecord } from '../src/records.js'
import type { DeadCursor, DeliveryStore } from '../src/store.js'

// how much of the first path level is worth printing: enough to tell /services from /api, never a whole
// path segment that could be a token
const PATH_SHOWN = 12

// A webhook URL is the credential: for a Discord or Slack hook the path is the secret, and an operator's
// terminal, shell history and screenshots are not where it belongs. Enough here to recognise the destination,
// not enough to send to it - the same rule senders/telegram.ts keeps for the token in its path.
export function redactedUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return '(unreadable url)'
  }
  const [, first = ''] = url.pathname.split('/')
  const head = first.slice(0, PATH_SHOWN)
  const hidden = url.pathname.length > head.length + 1 || url.search !== '' || url.hash !== ''
  return `${url.origin}/${head}${hidden ? '...' : ''}`
}

export function describeTarget(delivery: Pick<DeliveryRecord, 'channel' | 'target'>): string {
  return delivery.target.channel === 'webhook' ? redactedUrl(delivery.target.url) : delivery.channel
}

// a count an operator typed: undefined means "say so and stop", rather than handing "abc" to the AWS SDK and
// printing its stack trace
export function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined
}

type RedriveArgs = { table?: string | undefined; queue?: string | undefined; id?: string | undefined; all?: boolean }

// This command mutates production state, so the two selectors cannot both be honoured: "--id x --all" used to
// redrive everything while the named id went unchecked.
export function checkRedriveArgs(values: RedriveArgs): string | undefined {
  if (!values.table) return 'pass --table <name> or set TABLE_NAME'
  if (!values.queue) return 'pass --queue <url> or set DELIVERY_QUEUE_URL'
  if (values.id && values.all) return 'pass either --id <deliveryId> or --all, not both'
  if (!values.id && !values.all) return 'pass --id <deliveryId> or --all'
  return undefined
}

// The dead list is the only index there is: there is no lookup by delivery id alone. One page of it is not the
// list, so past a page --all is silently partial and --id reports a delivery that exists as missing - during
// exactly the incident this tool is for.
export async function allDead(store: Pick<DeliveryStore, 'listDeadPage'>, pageSize = 200): Promise<DeliveryRecord[]> {
  const found: DeliveryRecord[] = []
  let cursor: DeadCursor | undefined
  do {
    const page = await store.listDeadPage(pageSize, cursor)
    found.push(...page.deliveries)
    cursor = page.cursor
  } while (cursor)
  return found
}
