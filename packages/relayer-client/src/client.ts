import type {
  ApiErrorBody,
  ApiIssue,
  Hex,
  RelayerTx,
  RelayerTxBody,
  RelayRequest,
  RelayRequestBody,
  Signer,
  SignersBody,
} from './types.js'
import { isSignersBody, isTxBody } from './validate.js'

export type RelayerClientOptions = {
  // the API root, for example https://abc123.execute-api.us-east-1.amazonaws.com, without /v1
  baseUrl: string
  apiKey: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export class RelayerApiError extends Error {
  readonly status: number
  readonly code: string
  readonly issues: ApiIssue[]
  readonly revertData: Hex | null

  constructor(status: number, body: ApiErrorBody['error'], options?: { cause?: unknown }) {
    super(body.message, options)
    this.name = 'RelayerApiError'
    this.status = status
    this.code = body.code
    this.issues = body.issues ?? []
    this.revertData = body.revertData ?? null
  }
}

// A repeated call with the same idempotencyKey returns the original transaction, so a caller that timed out can
// call again safely. A request that differs from the original under the same key is refused with 409.
export async function relay(options: RelayerClientOptions, request: RelayRequest): Promise<RelayerTx> {
  const body: RelayRequestBody = {
    signerId: request.signerId,
    chainId: request.chainId,
    to: request.to,
    data: request.data,
    idempotencyKey: request.idempotencyKey,
    ...(request.value === undefined ? {} : { value: request.value.toString() }),
    ...(request.gasLimit === undefined ? {} : { gasLimit: request.gasLimit.toString() }),
    ...(request.reference === undefined ? {} : { reference: request.reference }),
    ...(request.dependsOn === undefined ? {} : { dependsOn: request.dependsOn }),
  }
  return toTx(await call(options, 'POST', '/v1/relayer/txs', isTxBody, body))
}

export async function getTx(options: RelayerClientOptions, txId: string): Promise<RelayerTx> {
  return toTx(await call(options, 'GET', `/v1/relayer/txs/${encodeURIComponent(txId)}`, isTxBody))
}

// the signers this API key may use, with the address each one signs as
export async function listSigners(options: RelayerClientOptions): Promise<Signer[]> {
  return (await call(options, 'GET', '/v1/relayer/signers', isSignersBody)).signers
}

async function call<T>(
  options: RelayerClientOptions,
  method: 'GET' | 'POST',
  path: string,
  isExpected: (body: unknown) => body is T,
  body?: unknown,
): Promise<T> {
  const fetchFn = options.fetch ?? globalThis.fetch
  let status = 0
  let text: string
  try {
    const response = await fetchFn(`${options.baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    })
    status = response.status
    text = await response.text()
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    const message = timedOut ? 'the request to the relayer timed out' : 'the relayer could not be reached'
    // a body cut off part way is as unknown an outcome as no answer at all
    throw new RelayerApiError(0, { code: 'network_error', message }, { cause: err })
  }
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  if (status < 200 || status > 299) {
    const error = (parsed as Partial<ApiErrorBody> | undefined)?.error
    if (typeof error?.code === 'string' && typeof error.message === 'string') throw new RelayerApiError(status, error)
    // API Gateway answers its own refusals, such as throttling, with only a message
    const gateway = (parsed as { message?: unknown } | undefined)?.message
    throw new RelayerApiError(status, {
      code: status === 429 ? 'throttled' : 'http_error',
      message: typeof gateway === 'string' && gateway ? gateway : `the relayer answered HTTP ${status}`,
    })
  }
  if (!isExpected(parsed)) {
    throw new RelayerApiError(status, {
      code: 'invalid_response',
      message: 'the relayer answered with an unexpected body',
    })
  }
  return parsed
}

function toTx(body: RelayerTxBody): RelayerTx {
  // a 0.1.x relayer leaves revertData out altogether, and the type promises one either way
  return { ...body, value: BigInt(body.value), gasLimit: BigInt(body.gasLimit), revertData: body.revertData ?? null }
}
