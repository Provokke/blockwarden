import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import { toDecodedValue } from '@blockwarden/relayer-client'
import type { DynamoDBRecord } from 'aws-lambda'

export type Row = Record<string, unknown>

export type StreamChange = {
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE'
  pk: string
  sk: string
  oldImage?: Row
  newImage?: Row
}

// aws-lambda's AttributeValue is the same shape written as an exclusive union, which is why the cast is here
// and nowhere else
type Image = Record<string, AttributeValue>

function toRow(image: unknown): Row | undefined {
  return image === undefined ? undefined : unmarshall(image as Image)
}

export function readRecord(record: DynamoDBRecord): StreamChange | undefined {
  const { eventName, dynamodb } = record
  if (!eventName || !dynamodb?.Keys) return undefined
  const keys = toRow(dynamodb.Keys)
  if (typeof keys?.PK !== 'string' || typeof keys.SK !== 'string') return undefined
  return {
    eventName,
    pk: keys.PK,
    sk: keys.SK,
    oldImage: toRow(dynamodb.OldImage),
    newImage: toRow(dynamodb.NewImage),
  }
}

// unmarshall returns a bigint for a number above 2^53 and a Set for a string or number set, and JSON.stringify
// throws on the first and writes {} for the second. A plain number is an argument viem decoded from an integer
// of 48 bits or fewer, and the published schema says every integer in a decoded argument is a decimal string,
// so toDecodedValue makes one wire form of it here instead of letting two reach a receiver.
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint' || typeof value === 'number') return toDecodedValue(value)
  if (value instanceof Set) return [...value].map(jsonSafe)
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Row).map(([k, v]) => [k, jsonSafe(v)]))
  }
  return value
}
