import { marshall } from '@aws-sdk/util-dynamodb'
import type { DynamoDBRecord } from 'aws-lambda'

type Row = Record<string, unknown>

export function streamRecord(
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE',
  keys: { PK: string; SK: string },
  images: { oldImage?: Row; newImage?: Row } = {},
): DynamoDBRecord {
  return {
    eventID: `e${Math.random().toString(16).slice(2)}`,
    eventName,
    eventVersion: '1.1',
    eventSource: 'aws:dynamodb',
    awsRegion: 'us-east-1',
    eventSourceARN: 'arn:aws:dynamodb:us-east-1:111122223333:table/blockwarden/stream/2026-09-20T00:00:00.000',
    dynamodb: {
      ApproximateCreationDateTime: 1_789_874_040,
      Keys: marshall(keys) as never,
      SequenceNumber: '000000000000000000001',
      SizeBytes: 84,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
      ...(images.oldImage ? { OldImage: marshall(images.oldImage, { removeUndefinedValues: true }) as never } : {}),
      ...(images.newImage ? { NewImage: marshall(images.newImage, { removeUndefinedValues: true }) as never } : {}),
    },
  }
}

export function matchRow(overrides: Row = {}): Row {
  return {
    PK: 'MATCH#0x1111111111111111111111111111111111111111111111111111111111111111',
    SK: 'META',
    matchKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
    ruleId: 'rule-1',
    chainId: 8453,
    blockNumber: 12_345_678,
    blockHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
    transactionHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
    logIndex: 4,
    ordinal: 0,
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    args: { from: '0x44', to: '0x55', value: '1000000000000000000' },
    status: 'provisional',
    firstSeenAt: '2026-09-20T10:00:00.000Z',
    expiresAt: 1_792_000_000,
    ...overrides,
  }
}

export function txRow(overrides: Row = {}): Row {
  return {
    PK: 'TX#tx-1',
    SK: 'META',
    txId: 'tx-1',
    kind: 'relay',
    signerId: 'demo',
    chainId: 84_532,
    from: '0x66',
    to: '0x77',
    data: '0x',
    value: '0',
    gasLimit: '21000',
    status: 'queued',
    attempts: [],
    history: [{ status: 'queued', at: '2026-09-20T10:00:00.000Z' }],
    enqueuedAt: 1_789_000_000_000,
    enqueues: 1,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    version: 0,
    ...overrides,
  }
}
