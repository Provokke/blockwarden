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

// aws-lambda's AttributeValue is the same shape as an exclusive union, hence the cast here and
// nowhere else
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

// unmarshall returns a bigint above 2^53 and a Set for string/number sets; JSON.stringify throws on
// the first and writes {} for the second. A plain number is an argument viem decoded from an
// integer of 48 bits or fewer, and the schema says those are decimal strings, so toDecodedValue
// makes one wire form of it.
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint' || typeof value === 'number') return toDecodedValue(value)
  if (value instanceof Set) return [...value].map(jsonSafe)
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Row).map(([k, v]) => [k, jsonSafe(v)]))
  }
  return value
}
