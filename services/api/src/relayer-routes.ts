import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { mayUseSigner, type Caller } from './caller.js'
import { decodeCursor, encodeCursor, error, ok, type ApiResult } from './http.js'
import type { RelayerStore, StoredTx } from './store.js'

const MAX_PAGE = 100

export type RelayerDeps = { store: RelayerStore; chainIds: number[] }

export async function handleListSigners(
  deps: RelayerDeps,
  caller: Caller,
  _event: APIGatewayProxyEventV2,
): Promise<ApiResult> {
  const signers = await deps.store.listSigners()
  return ok({ signers: signers.filter((signer) => mayUseSigner(caller, signer.signerId)) })
}

export async function handleGetTx(
  deps: RelayerDeps,
  caller: Caller,
  event: APIGatewayProxyEventV2,
): Promise<ApiResult> {
  const tx = await deps.store.getTx(event.pathParameters?.txId ?? '')
  // a transaction of a signer this caller may not use reads as missing, exactly as the relayer's own API
  // does (services/relayer/src/api.ts), so an id cannot be probed for existence
  if (!tx || !mayUseSigner(caller, tx.signerId)) return error(404, 'tx_not_found', 'no transaction has that id')
  return ok(tx)
}

// GSI2's own LastEvaluatedKey for a pending-transactions-by-chain query is always exactly these four
// attributes - PK, SK and GSI2PK as strings, GSI2SK as a number (packages/dynamo/src/table.ts's GSI2SK is
// type N) - proven by reading one back from DynamoDB Local in the integration test, not assumed. The cursor
// is unsigned base64, so any caller can hand back a crafted key; anything of another shape must never reach
// ExclusiveStartKey, where DynamoDB answers a bad key with a ValidationException that has no route-level
// catch (same convention as matches.ts's isMatchListKey and rules.ts's isRuleListKey)
const TX_LIST_KEY_ATTRS = ['PK', 'SK', 'GSI2PK'] as const

function isTxListKey(value: unknown): value is Record<(typeof TX_LIST_KEY_ATTRS)[number], string> & { GSI2SK: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== TX_LIST_KEY_ATTRS.length + 1) return false
  return TX_LIST_KEY_ATTRS.every((attr) => typeof record[attr] === 'string') && typeof record.GSI2SK === 'number'
}

export async function handleListTxs(
  deps: RelayerDeps,
  caller: Caller,
  event: APIGatewayProxyEventV2,
): Promise<ApiResult> {
  const query = event.queryStringParameters ?? {}
  // GSI2 holds a transaction only while it is unsettled, so status=pending is the one indexed view; every
  // other status would need a scan of this shared table and is refused with a message instead
  if (query.status !== undefined && query.status !== 'pending') {
    return error(400, 'unsupported_status', 'only status=pending is indexed; read a transaction by its id')
  }
  const chainId = query.chainId === undefined ? undefined : Number(query.chainId)
  if (chainId !== undefined && !deps.chainIds.includes(chainId)) {
    return error(400, 'unknown_chain', 'this deployment does not relay on that chain')
  }
  const limit = pageSize(query.limit)
  const chains = chainId === undefined ? deps.chainIds : [chainId]

  const start = query.cursor ? decodeCursor(query.cursor) : undefined
  if (query.cursor && !start) return error(400, 'invalid_cursor', 'that cursor cannot be read')
  // the cursor names which chain it stopped on, because a page can end inside any of them (same convention
  // as rules.ts's handleListRules)
  const startChain = typeof start?.chainId === 'number' ? start.chainId : chains[0]
  // a cursor naming a chain this listing is not walking would send chains.indexOf(startChain) to -1, and
  // chains.slice(-1) would then silently walk only the last chain instead of refusing the request
  if (start !== undefined && !chains.includes(startChain!)) {
    return error(400, 'invalid_cursor', 'the cursor names a chain this listing is not walking')
  }
  if (start?.key !== undefined && !isTxListKey(start.key)) {
    return error(400, 'invalid_cursor', 'the cursor key is not shaped like one this listing could have issued')
  }
  const startKey = start?.key !== undefined && isTxListKey(start.key) ? start.key : undefined

  // the store hands back a page and only then this handler drops what the caller may not see, so an API key
  // can get a short page with a cursor. That is correct and is not hidden by looping until the page is full -
  // looping would let a key measure how many transactions another signer has by counting the extra reads it
  // takes to fill the page
  const txs: StoredTx[] = []
  let cursor: string | undefined
  for (const chain of chains.slice(chains.indexOf(startChain!))) {
    const page = await deps.store.listPendingTxs(chain, limit - txs.length, chain === startChain ? startKey : undefined)
    txs.push(...page.txs.filter((tx) => mayUseSigner(caller, tx.signerId)))
    if (page.cursor) {
      cursor = encodeCursor({ chainId: chain, key: page.cursor })
      break
    }
    if (txs.length >= limit) {
      // this chain's own query never needed a cursor, but there may be more chains still to walk
      const next = chains[chains.indexOf(chain) + 1]
      if (next !== undefined) cursor = encodeCursor({ chainId: next })
      break
    }
  }
  return ok({ txs, ...(cursor ? { cursor } : {}) })
}

function pageSize(raw: string | undefined): number {
  const asked = Number(raw ?? MAX_PAGE)
  if (!Number.isInteger(asked) || asked < 1) return MAX_PAGE
  return Math.min(asked, MAX_PAGE)
}
