import { createHash } from 'node:crypto'
import type { RelayerTxBody } from '@blockwarden/relayer-client'
import type { Address, Hex } from 'viem'
import { z } from 'zod'
import { EstimateError, type RelayerChain } from './chain.js'
import { checkPolicy, weiToGweiCeil, weiToGweiFloor, worstCaseCostWei, type PolicyIssue } from './policy.js'
import type { TxQueue } from './queue.js'
import { dependencyState, toTxBody, type ApiKeyRecord, type SignerRecord, type TxRecord } from './records.js'
import type { RelayerStore } from './store.js'

export type ApiResult = { status: number; body: unknown }

export type ErrorBody = {
  error: { code: string; message: string; issues?: PolicyIssue[]; revertData?: Hex }
}

export type SubmitDeps = {
  store: RelayerStore
  chainFor(chainId: number): RelayerChain | undefined
  addressFor(signer: SignerRecord): Promise<Address>
  queue: TxQueue
  now(): Date
  newTxId(): string
  log(message: string, data?: Record<string, unknown>, level?: 'warn' | 'error'): void
}

const hex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, 'expected even-length hex')
const decimal = z.string().regex(/^\d{1,78}$/, 'expected a decimal integer string')

export const relayRequestSchema = z.object({
  signerId: z.string().min(1).max(64),
  chainId: z.number().int().positive(),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte hex address'),
  data: hex,
  value: decimal.optional(),
  gasLimit: decimal.optional(),
  idempotencyKey: z.string().regex(/^[\x21-\x7e]{1,128}$/, 'expected 1 to 128 printable ASCII characters'),
  reference: z.string().max(128).optional(),
  dependsOn: z.string().min(1).max(64).optional(),
})

// gas estimates move between the estimate and inclusion, so a limit the caller did not set gets 20% headroom
const ESTIMATE_HEADROOM_PERCENT = 120n

export function error(
  status: number,
  code: string,
  message: string,
  extra: Partial<ErrorBody['error']> = {},
): ApiResult {
  return { status, body: { error: { code, message, ...extra } } satisfies ErrorBody }
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex')
}

type RelayRequest = z.infer<typeof relayRequestSchema>

function requestHash(request: RelayRequest): string {
  const canonical = {
    signerId: request.signerId,
    chainId: request.chainId,
    to: request.to.toLowerCase(),
    data: request.data.toLowerCase(),
    // BigInt strips leading zeros, so "00" and "0" (or an omitted value) hash the same
    value: BigInt(request.value ?? '0').toString(),
    gasLimit: request.gasLimit === undefined ? null : BigInt(request.gasLimit).toString(),
    reference: request.reference ?? null,
    dependsOn: request.dependsOn ?? null,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

async function replay(deps: SubmitDeps, txId: string, hash: string): Promise<ApiResult> {
  const existing = await deps.store.getTx(txId)
  if (!existing) throw new Error(`idempotency record points at missing transaction ${txId}`)
  if (existing.requestHash !== hash) {
    return error(409, 'idempotency_conflict', 'this idempotency key was already used for a different request')
  }
  return { status: 200, body: toTxBody(existing) satisfies RelayerTxBody }
}

export async function submitTx(deps: SubmitDeps, apiKey: ApiKeyRecord, input: unknown): Promise<ApiResult> {
  const parsed = relayRequestSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    return error(400, 'invalid_request', 'the request body is invalid', { issues })
  }
  const request = parsed.data
  if (!apiKey.signerIds.includes(request.signerId)) {
    return error(403, 'signer_not_allowed', 'this API key may not use that signer')
  }
  const hash = requestHash(request)
  const previous = await deps.store.getIdempotency(apiKey.hash, request.idempotencyKey)
  if (previous) return replay(deps, previous.txId, hash)

  const signer = await deps.store.getSigner(request.signerId)
  if (!signer) return error(404, 'signer_not_found', 'no signer has that id')
  const chain = deps.chainFor(request.chainId)
  if (!chain || !signer.chainIds.includes(request.chainId)) {
    return error(422, 'chain_not_enabled', 'the signer does not relay on that chain')
  }

  const to = request.to as Address
  const data = request.data as Hex
  const value = BigInt(request.value ?? '0')
  // checked before the estimate, so a request the policy refuses costs no RPC call
  const early = checkPolicy(signer.policy, { to, data, value, gasLimit: BigInt(request.gasLimit ?? '0') })
  if (early.length > 0)
    return error(422, 'policy_violation', 'the signer policy refuses this request', { issues: early })

  const from = await deps.addressFor(signer)
  let gasLimit: bigint
  if (request.dependsOn !== undefined) {
    // the call may only succeed once its dependency is mined, so the signer estimates it then instead
    if (request.gasLimit === undefined) {
      return error(400, 'invalid_request', 'a transaction with dependsOn needs a gasLimit', {
        issues: [{ path: 'gasLimit', message: 'required with dependsOn' }],
      })
    }
    const dependency = await deps.store.getTx(request.dependsOn)
    if (!dependency || !apiKey.signerIds.includes(dependency.signerId) || dependency.chainId !== request.chainId) {
      return error(422, 'dependency_not_found', 'no transaction on this chain has the dependsOn id')
    }
    if (dependencyState(dependency) === 'unsuccessful') {
      return error(422, 'dependency_failed', 'the transaction this one depends on did not succeed')
    }
    gasLimit = BigInt(request.gasLimit)
  } else {
    try {
      const estimate = await chain.estimateGas({ from, to, data, value })
      gasLimit =
        request.gasLimit === undefined ? (estimate * ESTIMATE_HEADROOM_PERCENT) / 100n : BigInt(request.gasLimit)
    } catch (err) {
      if (!(err instanceof EstimateError)) throw err
      // the detailed message can carry the RPC URL, which may hold an API key; only a fixed message reaches the caller
      deps.log(
        'estimate failed',
        {
          kind: err.kind,
          chainId: request.chainId,
          signerId: signer.signerId,
          error: err.message,
        },
        'warn',
      )
      if (err.kind === 'reverted') {
        return error(422, 'estimate_reverted', 'the transaction would revert', { revertData: err.revertData ?? '0x' })
      }
      if (err.kind === 'unavailable') return error(503, 'rpc_unavailable', 'the RPC endpoint is unavailable')
      return error(422, 'estimate_failed', 'the gas estimate failed')
    }
  }
  const late = checkPolicy(signer.policy, { to, data, value, gasLimit })
  if (late.length > 0) return error(422, 'policy_violation', 'the signer policy refuses this request', { issues: late })

  const cost = worstCaseCostWei(signer.policy, { value, gasLimit })
  const capWei = BigInt(signer.policy.dailySpendCapWei)
  const now = deps.now()
  const nowIso = now.toISOString()
  const tx: TxRecord = {
    txId: deps.newTxId(),
    kind: 'relay',
    signerId: signer.signerId,
    chainId: request.chainId,
    from,
    to,
    data,
    value: value.toString(),
    gasLimit: gasLimit.toString(),
    status: 'queued',
    attempts: [],
    idempotencyKey: request.idempotencyKey,
    ...(request.reference === undefined ? {} : { reference: request.reference }),
    ...(request.dependsOn === undefined ? {} : { dependsOn: request.dependsOn }),
    apiKeyHash: apiKey.hash,
    requestHash: hash,
    enqueuedAt: now.getTime(),
    enqueues: 1,
    history: [{ status: 'queued', at: nowIso }],
    createdAt: nowIso,
    updatedAt: nowIso,
    version: 1,
  }
  const result =
    cost > capWei
      ? ({ created: false, reason: 'spend-cap' } as const)
      : await deps.store.createTx(
          tx,
          { day: nowIso.slice(0, 10), costGwei: weiToGweiCeil(cost), capGwei: weiToGweiFloor(capWei) },
          now.getTime(),
        )
  if (!result.created) {
    if (result.reason === 'duplicate') {
      const raced = await deps.store.getIdempotency(apiKey.hash, request.idempotencyKey)
      if (!raced) throw new Error('an idempotency key conflicted but cannot be read')
      return replay(deps, raced.txId, hash)
    }
    return error(422, 'spend_cap_exceeded', 'the signer has reached its daily spend cap on this chain')
  }

  try {
    await deps.queue.send(tx)
  } catch (err) {
    // the transaction is stored, and the sweeper requeues a queued transaction that sat too long
    deps.log('enqueue failed; the sweeper will requeue it', { txId: tx.txId, error: (err as Error).message }, 'warn')
  }
  return { status: 202, body: toTxBody(tx) satisfies RelayerTxBody }
}
