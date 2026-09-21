import {
  DescribeStreamCommand,
  DynamoDBStreamsClient,
  GetRecordsCommand,
  GetShardIteratorCommand,
} from '@aws-sdk/client-dynamodb-streams'
import { DescribeTableCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBRecord } from 'aws-lambda'

// DynamoDB Local serves the Streams API on the same endpoint as the table, and re-reading from TRIM_HORIZON
// returns the whole history every time, so the reader keeps its own position by sequence number
export async function streamReader(client: DynamoDBClient, endpoint: string, tableName: string) {
  const streams = new DynamoDBStreamsClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  })
  const { Table } = await client.send(new DescribeTableCommand({ TableName: tableName }))
  const streamArn = Table!.LatestStreamArn!
  const seen = new Set<string>()

  return {
    streamArn,
    async read(): Promise<DynamoDBRecord[]> {
      const { StreamDescription } = await streams.send(new DescribeStreamCommand({ StreamArn: streamArn }))
      const fresh: DynamoDBRecord[] = []
      for (const shard of StreamDescription!.Shards ?? []) {
        const { ShardIterator } = await streams.send(
          new GetShardIteratorCommand({
            StreamArn: streamArn,
            ShardId: shard.ShardId!,
            ShardIteratorType: 'TRIM_HORIZON',
          }),
        )
        let iterator = ShardIterator
        while (iterator) {
          const page = await streams.send(new GetRecordsCommand({ ShardIterator: iterator, Limit: 1000 }))
          for (const record of page.Records ?? []) {
            const id = record.dynamodb?.SequenceNumber ?? ''
            if (seen.has(id)) continue
            seen.add(id)
            fresh.push(record as unknown as DynamoDBRecord)
          }
          if ((page.Records ?? []).length === 0) break
          iterator = page.NextShardIterator
        }
      }
      return fresh
    },
    destroy() {
      streams.destroy()
    },
  }
}
