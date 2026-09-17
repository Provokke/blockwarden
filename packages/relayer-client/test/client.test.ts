import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getTx, listSigners, relay, RelayerApiError } from '../src/client.js'
import type { RelayerTxBody } from '../src/types.js'

type Seen = {
  method: string
  url: string
  authorization: string | undefined
  contentType: string | undefined
  body: string
}

const TX: RelayerTxBody = {
  txId: 'tx-1',
  kind: 'relay',
  signerId: 'billing',
  chainId: 84532,
  from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  to: '0x000000000000000000000000000000000000dEaD',
  data: '0x',
  value: '340282366920938463463374607431768211456',
  gasLimit: '21000',
  status: 'queued',
  nonce: null,
  hash: null,
  blockNumber: null,
  blockHash: null,
  receiptStatus: null,
  error: null,
  fillerTxId: null,
  idempotencyKey: 'charge-1',
  reference: 'sub_1:period_3',
  dependsOn: null,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
}

describe('relayer client', () => {
  let server: Server
  let baseUrl: string
  let seen: Seen[] = []
  let answer: { status: number; body: string } = { status: 200, body: '{}' }

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen.push({
          method: req.method!,
          url: req.url!,
          authorization: req.headers.authorization,
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf8'),
        })
        res.writeHead(answer.status, { 'content-type': 'application/json' })
        res.end(answer.body)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    // a trailing slash, as an operator might paste it, must not produce //v1
    baseUrl = `http://127.0.0.1:${address.port}/`
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  beforeEach(() => {
    seen = []
  })

  it('posts the request with bigints as decimal strings and returns bigints', async () => {
    answer = { status: 202, body: JSON.stringify(TX) }
    const tx = await relay(
      { baseUrl, apiKey: 'bw_secret' },
      {
        signerId: 'billing',
        chainId: 84532,
        to: TX.to,
        data: '0x',
        value: 2n ** 128n,
        gasLimit: 21_000n,
        idempotencyKey: 'charge-1',
        reference: 'sub_1:period_3',
        dependsOn: 'tx-0',
      },
    )
    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/v1/relayer/txs',
        authorization: 'Bearer bw_secret',
        contentType: 'application/json',
        body: JSON.stringify({
          signerId: 'billing',
          chainId: 84532,
          to: TX.to,
          data: '0x',
          idempotencyKey: 'charge-1',
          value: '340282366920938463463374607431768211456',
          gasLimit: '21000',
          reference: 'sub_1:period_3',
          dependsOn: 'tx-0',
        }),
      },
    ])
    expect(tx.value).toBe(2n ** 128n)
    expect(tx.gasLimit).toBe(21_000n)
    expect(tx.reference).toBe('sub_1:period_3')
  })

  it('leaves out optional fields that were not given', async () => {
    answer = { status: 202, body: JSON.stringify(TX) }
    await relay({ baseUrl, apiKey: 'k' }, { signerId: 's', chainId: 1, to: TX.to, data: '0x12', idempotencyKey: 'i' })
    expect(JSON.parse(seen[0]!.body)).toEqual({
      signerId: 's',
      chainId: 1,
      to: TX.to,
      data: '0x12',
      idempotencyKey: 'i',
    })
  })

  it('gets a transaction by id, escaping the id into the path', async () => {
    answer = { status: 200, body: JSON.stringify({ ...TX, status: 'mined', receiptStatus: 'reverted' }) }
    const tx = await getTx({ baseUrl, apiKey: 'k' }, 'a/b')
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/v1/relayer/txs/a%2Fb', contentType: undefined, body: '' })
    expect(tx.receiptStatus).toBe('reverted')
  })

  it('lists signers', async () => {
    const signers = [{ signerId: 'billing', address: TX.from, chainIds: [84532] }]
    answer = { status: 200, body: JSON.stringify({ signers }) }
    expect(await listSigners({ baseUrl, apiKey: 'k' })).toEqual(signers)
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/v1/relayer/signers' })
  })

  it('throws the API error with its code, issues and revert data', async () => {
    answer = {
      status: 422,
      body: JSON.stringify({
        error: { code: 'estimate_reverted', message: 'eth_estimateGas reverted', revertData: '0x08c379a0' },
      }),
    }
    const err = await getTx({ baseUrl, apiKey: 'k' }, 'x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayerApiError)
    expect(err).toMatchObject({ status: 422, code: 'estimate_reverted', revertData: '0x08c379a0', issues: [] })

    answer = {
      status: 400,
      body: JSON.stringify({
        error: { code: 'invalid_request', message: 'bad', issues: [{ path: 'to', message: 'x' }] },
      }),
    }
    expect(await getTx({ baseUrl, apiKey: 'k' }, 'x').catch((e: unknown) => e)).toMatchObject({
      code: 'invalid_request',
      issues: [{ path: 'to', message: 'x' }],
      revertData: null,
    })
  })

  it('throws an http_error for a failure body that is not an API error', async () => {
    answer = { status: 502, body: '<html>bad gateway</html>' }
    expect(await getTx({ baseUrl, apiKey: 'k' }, 'x').catch((e: unknown) => e)).toMatchObject({
      status: 502,
      code: 'http_error',
    })
  })

  it('throws bad_response for a success without JSON', async () => {
    answer = { status: 200, body: '' }
    expect(await getTx({ baseUrl, apiKey: 'k' }, 'x').catch((e: unknown) => e)).toMatchObject({ code: 'bad_response' })
  })
})
