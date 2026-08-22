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

  constructor(status: number, body: ApiErrorBody['error']) {
    super(body.message)
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
  }
  return toTx(await call<RelayerTxBody>(options, 'POST', '/v1/relayer/txs', body))
}

export async function getTx(options: RelayerClientOptions, txId: string): Promise<RelayerTx> {
  return toTx(await call<RelayerTxBody>(options, 'GET', `/v1/relayer/txs/${encodeURIComponent(txId)}`))
}

// the signers this API key may use, with the address each one signs as
export async function listSigners(options: RelayerClientOptions): Promise<Signer[]> {
  return (await call<SignersBody>(options, 'GET', '/v1/relayer/signers')).signers
}

async function call<T>(
  options: RelayerClientOptions,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const fetchFn = options.fetch ?? globalThis.fetch
  const response = await fetchFn(`${options.baseUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const error = (parsed as Partial<ApiErrorBody> | undefined)?.error
    throw new RelayerApiError(
      response.status,
      error?.code && error.message
        ? error
        : { code: 'http_error', message: `the relayer answered HTTP ${response.status}` },
    )
  }
  if (parsed === undefined) {
    throw new RelayerApiError(response.status, { code: 'bad_response', message: 'the relayer answered without JSON' })
  }
  return parsed as T
}

function toTx(body: RelayerTxBody): RelayerTx {
  return { ...body, value: BigInt(body.value), gasLimit: BigInt(body.gasLimit) }
}
