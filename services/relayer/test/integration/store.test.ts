import { PutItemCommand } from '@aws-sdk/client-dynamodb'
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { GSI2 } from '@blockwarden/dynamo'
import { startDynamo, type Dynamo } from '@blockwarden/dynamo/testing'
import { InvalidInputRpcError, keccak256, RpcRequestError, toHex, type Hex } from 'viem'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { describeError } from '../../src/chain.js'
import { keys } from '../../src/keys.js'
import { RelayerStore, TxConflictError } from '../../src/store.js'
import { CHAIN_ID, queuedTx, signerRecord } from '../helpers/fixtures.js'

const FROM = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const NOW = Date.parse('2026-09-17T12:00:00.000Z')
const spend = (costGwei: number, capGwei = 1_000) => ({ day: '2026-09-17', costGwei, capGwei })

describe('RelayerStore', () => {
  let dynamo: Dynamo
  let tableName: string
  let store: RelayerStore

  beforeAll(async () => {
    dynamo = await startDynamo()
  })

  afterAll(async () => {
    await dynamo?.stop()
  })

  beforeEach(async () => {
    tableName = await dynamo.newTable()
    store = new RelayerStore(dynamo.doc, tableName)
  })

  const pendingIds = async () => {
    const { Items } = await dynamo.doc.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: GSI2,
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': keys.pendingTxs(CHAIN_ID) },
      }),
    )
    return (Items ?? []).map((i) => i.txId as string)
  }

  describe('createTx', () => {
    it('stores the tx, its idempotency record and the reservation together', async () => {
      const tx = queuedTx(FROM)
      expect(await store.createTx(tx, spend(300), NOW)).toEqual({ created: true })
      expect(await store.getTx(tx.txId)).toEqual(tx)
      expect(await store.getIdempotency(tx.apiKeyHash!, tx.idempotencyKey!)).toEqual({ txId: tx.txId })
      const { Item } = await dynamo.doc.send(
        new GetCommand({ TableName: tableName, Key: keys.spend('billing', CHAIN_ID, '2026-09-17') }),
      )
      expect(Item).toMatchObject({ spentGwei: 300, expiresAt: Math.floor(NOW / 1000) + 2 * 24 * 3600 })
      const idempotency = await dynamo.doc.send(
        new GetCommand({ TableName: tableName, Key: keys.idempotency(tx.apiKeyHash!, tx.idempotencyKey!) }),
      )
      expect(idempotency.Item?.expiresAt).toBe(Math.floor(NOW / 1000) + 24 * 3600)
      expect(await pendingIds()).toEqual([tx.txId])
    })

    it('reports a duplicate key and writes nothing for it, reservation included', async () => {
      const first = queuedTx(FROM)
      await store.createTx(first, spend(300), NOW)
      const second = queuedTx(FROM, { idempotencyKey: first.idempotencyKey })
      expect(await store.createTx(second, spend(300), NOW)).toEqual({ created: false, reason: 'duplicate' })
      expect(await store.getTx(second.txId)).toBeUndefined()
      const { Item } = await dynamo.doc.send(
        new GetCommand({ TableName: tableName, Key: keys.spend('billing', CHAIN_ID, '2026-09-17') }),
      )
      expect(Item?.spentGwei).toBe(300)
    })

    it('lets reservations add up to the cap exactly and refuses the next one', async () => {
      expect(await store.createTx(queuedTx(FROM), spend(600), NOW)).toEqual({ created: true })
      expect(await store.createTx(queuedTx(FROM), spend(400), NOW)).toEqual({ created: true })
      const over = queuedTx(FROM)
      expect(await store.createTx(over, spend(1), NOW)).toEqual({ created: false, reason: 'spend-cap' })
      expect(await store.getTx(over.txId)).toBeUndefined()
    })

    it('refuses a first reservation of the day that is already over the cap', async () => {
      expect(await store.createTx(queuedTx(FROM), spend(1_001), NOW)).toEqual({ created: false, reason: 'spend-cap' })
    })

    it('lets exactly as many racing creations through as the cap has room for', async () => {
      const txs = Array.from({ length: 10 }, () => queuedTx(FROM))
      const results = await Promise.all(txs.map((tx) => store.createTx(tx, spend(300), NOW)))
      expect(results.filter((r) => r.created)).toHaveLength(3)
      expect(results.filter((r) => !r.created && r.reason === 'spend-cap')).toHaveLength(7)
      // the counter only grows, so its final value is the most it ever held
      const { Item } = await dynamo.doc.send(
        new GetCommand({ TableName: tableName, Key: keys.spend('billing', CHAIN_ID, '2026-09-17') }),
      )
      expect(Item?.spentGwei).toBe(900)
      expect((await Promise.all(txs.map((tx) => store.getTx(tx.txId)))).filter(Boolean)).toHaveLength(3)
      expect(await pendingIds()).toHaveLength(3)
    })

    it('creates one transaction when racing creations share an idempotency key', async () => {
      const first = queuedTx(FROM)
      const txs = [first, ...Array.from({ length: 7 }, () => queuedTx(FROM, { idempotencyKey: first.idempotencyKey }))]
      const results = await Promise.all(txs.map((tx) => store.createTx(tx, spend(100), NOW)))
      const winners = txs.filter((_, i) => results[i]!.created)
      expect(winners).toHaveLength(1)
      expect(results.filter((r) => !r.created)).toEqual(Array(7).fill({ created: false, reason: 'duplicate' }))
      // every loser's caller replays the winner through the key
      expect(await store.getIdempotency(first.apiKeyHash!, first.idempotencyKey!)).toEqual({ txId: winners[0]!.txId })
      const stored = await Promise.all(txs.map((tx) => store.getTx(tx.txId)))
      expect(stored.filter(Boolean).map((tx) => tx!.txId)).toEqual([winners[0]!.txId])
      const { Item } = await dynamo.doc.send(
        new GetCommand({ TableName: tableName, Key: keys.spend('billing', CHAIN_ID, '2026-09-17') }),
      )
      expect(Item?.spentGwei).toBe(100)
    })

    it('keeps one day and one chain apart from another', async () => {
      await store.createTx(queuedTx(FROM), spend(1_000), NOW)
      expect(await store.createTx(queuedTx(FROM), { ...spend(1_000), day: '2026-09-18' }, NOW)).toEqual({
        created: true,
      })
      expect(await store.createTx(queuedTx(FROM, { chainId: 421614 }), spend(1_000), NOW)).toEqual({ created: true })
    })
  })

  describe('saveTx', () => {
    it('bumps the version, and refuses a write from a stale read', async () => {
      const tx = queuedTx(FROM)
      await store.createTx(tx, spend(1), NOW)
      const saved = await store.saveTx({ ...tx, status: 'submitted' }, '2026-09-17T12:01:00.000Z')
      expect(saved.version).toBe(2)
      expect(await store.getTx(tx.txId)).toEqual(saved)
      await expect(store.saveTx({ ...tx, status: 'failed' }, 'x')).rejects.toBeInstanceOf(TxConflictError)
    })

    it('keeps a tx in the pending index until it settles', async () => {
      const tx = queuedTx(FROM)
      await store.createTx(tx, spend(1), NOW)
      const mined = await store.saveTx({ ...tx, status: 'mined' }, 'x')
      expect(await pendingIds()).toEqual([tx.txId])
      await store.saveTx({ ...mined, status: 'confirmed' }, 'x')
      expect(await pendingIds()).toEqual([])
    })

    it('saves a transaction at every limit, with the longest refusal a node can give', async () => {
      // the reviewer's worst case: 8 KB of calldata, 64 attempts, 512 dropped hashes, 4 abandoned attempts, and a
      // node that answers by echoing the raw transaction back
      const data = `0x${'ab'.repeat(8_192)}` as Hex
      const raw = `0x${'cd'.repeat(8_600)}` as Hex
      const rejected = describeError(
        new InvalidInputRpcError(
          new RpcRequestError({ body: {}, url: 'http://node', error: { code: -32000, message: `refused: ${raw}` } }),
        ),
      )
      const attempt = (i: number, bytes: Hex) => ({
        hash: keccak256(toHex(i)),
        raw: bytes,
        maxFeePerGas: '100000000000',
        maxPriorityFeePerGas: '10000000000',
        signedAt: NOW,
        broadcastAt: NOW,
        acceptedAt: NOW,
        rejected,
      })
      const tx = queuedTx(FROM, {
        status: 'submitted',
        nonce: 3,
        data,
        attempts: Array.from({ length: 64 }, (_, i) => attempt(i, i < 48 ? '0x' : raw)),
        abandonedAttempts: Array.from({ length: 4 }, (_, i) => ({ ...attempt(1_000 + i, '0x'), nonce: 2 })),
        retiredHashes: Array.from({ length: 512 }, (_, i) => keccak256(toHex(2_000 + i))),
        error: rejected,
      })
      expect(await store.createTx(tx, spend(1), NOW)).toEqual({ created: true })

      const saved = await store.saveTx(tx, '2026-09-17T12:00:00.000Z')
      expect(saved.version).toBe(2)
      expect((await store.getTx(tx.txId))?.attempts).toHaveLength(64)
      // DynamoDB refuses an item over 400 KB, and after that the transaction cannot even be marked failed
      expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(400 * 1024)
    })

    it('drops fields that were removed from the record', async () => {
      const tx = queuedTx(FROM, { needsBump: true })
      await store.createTx(tx, spend(1), NOW)
      const { needsBump: _drop, ...rest } = tx
      await store.saveTx(rest, 'x')
      expect((await store.getTx(tx.txId))?.needsBump).toBeUndefined()
    })
  })

  describe('nonces', () => {
    it('assigns consecutive nonces and leaves a tx that already has one alone', async () => {
      const txs = [queuedTx(FROM), queuedTx(FROM), queuedTx(FROM)]
      for (const tx of txs) await store.createTx(tx, spend(1), NOW)
      const nonces = []
      for (const tx of txs) nonces.push((await store.assignNonce(tx, 'x')).nonce)
      expect(nonces).toEqual([0, 1, 2])
      const again = await store.assignNonce((await store.getTx(txs[0]!.txId))!, 'x')
      expect(again.nonce).toBe(0)
      expect(await store.getNextNonce('billing', CHAIN_ID)).toBe(3)
    })

    it('never hands out one nonce twice when assignments race', async () => {
      const txs = Array.from({ length: 8 }, () => queuedTx(FROM))
      for (const tx of txs) await store.createTx(tx, spend(1), NOW)
      const assigned = await Promise.all(txs.map((tx) => store.assignNonce(tx, 'x')))
      expect(assigned.map((t) => t.nonce).sort((a, b) => a! - b!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    })

    it('does not consume a nonce when the tx changed since it was read', async () => {
      const tx = queuedTx(FROM)
      await store.createTx(tx, spend(1), NOW)
      await store.saveTx(tx, 'x')
      await expect(store.assignNonce(tx, 'x')).rejects.toBeInstanceOf(TxConflictError)
      expect(await store.getNextNonce('billing', CHAIN_ID)).toBeUndefined()
    })

    it('raises the counter to the chain nonce but never lowers it', async () => {
      await store.raiseNonce('billing', CHAIN_ID, 5)
      expect(await store.getNextNonce('billing', CHAIN_ID)).toBe(5)
      await store.raiseNonce('billing', CHAIN_ID, 3)
      expect(await store.getNextNonce('billing', CHAIN_ID)).toBe(5)
      const tx = queuedTx(FROM)
      await store.createTx(tx, spend(1), NOW)
      expect((await store.assignNonce(tx, 'x')).nonce).toBe(5)
    })
  })

  describe('failWithFiller', () => {
    it('fails the tx and creates the filler in one write', async () => {
      const tx = queuedTx(FROM, { nonce: 4 })
      await store.createTx(tx, spend(1), NOW)
      const filler = queuedTx(FROM, { kind: 'filler', nonce: 4, fillsTxId: tx.txId, idempotencyKey: undefined })
      const { failed } = await store.failWithFiller({ ...tx, status: 'failed', fillerTxId: filler.txId }, filler, 'x')
      expect(failed.version).toBe(2)
      expect((await store.getTx(tx.txId))?.status).toBe('failed')
      expect(await store.getTx(filler.txId)).toEqual(filler)
      expect(await pendingIds()).toEqual([filler.txId])
    })

    it('creates no filler when the tx changed since it was read', async () => {
      const tx = queuedTx(FROM, { nonce: 4 })
      await store.createTx(tx, spend(1), NOW)
      await store.saveTx(tx, 'x')
      const filler = queuedTx(FROM, { kind: 'filler', nonce: 4 })
      await expect(store.failWithFiller({ ...tx, status: 'failed' }, filler, 'x')).rejects.toBeInstanceOf(
        TxConflictError,
      )
      expect(await store.getTx(filler.txId)).toBeUndefined()
    })
  })

  describe('pauses', () => {
    it('unpauses only the pause that was read', async () => {
      const pause = { signerId: 'billing', chainId: CHAIN_ID, address: FROM, requiredWei: '5', since: 'a' } as const
      await store.pause(pause)
      expect(await store.getPause('billing', CHAIN_ID)).toEqual(pause)
      await store.pause({ ...pause, since: 'b' })
      expect(await store.unpause(pause)).toBe(false)
      expect(await store.unpause({ ...pause, since: 'b' })).toBe(true)
      expect(await store.getPause('billing', CHAIN_ID)).toBeUndefined()
    })
  })

  describe('signers and API keys', () => {
    it('reads a signer back through the policy schema', async () => {
      const signer = signerRecord({ webhooks: ['https://example.com/hook'] })
      await store.putSigner(signer)
      expect(await store.getSigner('billing')).toEqual(signer)
    })

    // the DynamoDB JSON that infra/terraform/modules/relayer/signers.tf writes, so a change on either side shows here
    it('reads the signer and API key items Terraform writes', async () => {
      await dynamo.client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            PK: { S: 'SIGNER#billing' },
            SK: { S: 'META' },
            signerId: { S: 'billing' },
            keyId: { S: 'arn:aws:kms:us-east-1:111122223333:key/abc' },
            chainIds: { L: [{ N: '84532' }, { N: '421614' }] },
            webhooks: { L: [] },
            webhookSecretParameter: { S: '/billing/webhook-secret' },
            policy: {
              M: {
                allowedTo: {
                  L: [
                    { M: { address: { S: '0x5FbDB2315678afecb367f032d93F642f64180aa3' } } },
                    {
                      M: {
                        address: { S: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
                        selectors: { L: [{ S: '0xa9059cbb' }] },
                        transferRecipients: { L: [{ S: '0x000000000000000000000000000000000000bEEF' }] },
                      },
                    },
                  ],
                },
                maxGasLimit: { N: '300000' },
                maxFeePerGas: { S: '2000000000' },
                maxPriorityFeePerGas: { S: '1000000000' },
                dailySpendCapWei: { S: '20000000000000000' },
              },
            },
          },
        }),
      )
      expect(await store.getSigner('billing')).toEqual({
        signerId: 'billing',
        keyId: 'arn:aws:kms:us-east-1:111122223333:key/abc',
        chainIds: [84532, 421614],
        webhooks: [],
        webhookSecretParameter: '/billing/webhook-secret',
        policy: {
          allowedTo: [
            { address: '0x5FbDB2315678afecb367f032d93F642f64180aa3' },
            {
              address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              selectors: ['0xa9059cbb'],
              transferRecipients: ['0x000000000000000000000000000000000000bEEF'],
            },
          ],
          maxGasLimit: 300_000,
          maxFeePerGas: '2000000000',
          maxPriorityFeePerGas: '1000000000',
          dailySpendCapWei: '20000000000000000',
        },
      })

      const hash = 'd'.repeat(64)
      await dynamo.client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            PK: { S: `APIKEY#${hash}` },
            SK: { S: 'META' },
            signerIds: { L: [{ S: 'billing' }] },
            label: { S: 'billing-worker' },
          },
        }),
      )
      expect(await store.getApiKey(hash)).toEqual({ hash, signerIds: ['billing'], label: 'billing-worker' })
    })

    it('refuses a stored signer whose policy is invalid', async () => {
      await dynamo.doc.send(
        new PutCommand({
          TableName: tableName,
          Item: { ...keys.signer('broken'), signerId: 'broken', keyId: 'k', chainIds: [1], policy: { allowedTo: [] } },
        }),
      )
      await expect(store.getSigner('broken')).rejects.toThrow()
    })

    it('stores an API key once', async () => {
      const record = { hash: 'c'.repeat(64), signerIds: ['billing'], label: 'billwarden', createdAt: 'x' }
      await store.putApiKey(record)
      expect(await store.getApiKey(record.hash)).toEqual(record)
      await expect(store.putApiKey(record)).rejects.toThrow()
    })
  })
})
