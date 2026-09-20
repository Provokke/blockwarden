import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

export function createDocumentClient(client: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } })
}

export function isConditionFailure(err: unknown): boolean {
  return (err as Error | undefined)?.name === 'ConditionalCheckFailedException'
}
