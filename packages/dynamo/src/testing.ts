import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { GenericContainer, Wait } from 'testcontainers'
import { createDocumentClient } from './document-client.js'
import { tableDefinition } from './table.js'

export type Dynamo = Awaited<ReturnType<typeof startDynamo>>

export async function startDynamo() {
  const container = await new GenericContainer('amazon/dynamodb-local:3.3.1')
    .withExposedPorts(8000)
    .withWaitStrategy(Wait.forListeningPorts())
    .start()
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(8000)}`
  const client = new DynamoDBClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  })
  const doc = createDocumentClient(client)
  let tables = 0

  return {
    endpoint,
    client,
    doc,
    async newTable(): Promise<string> {
      const name = `blockwarden-test-${++tables}`
      await client.send(new CreateTableCommand(tableDefinition(name)))
      return name
    },
    async stop(): Promise<void> {
      client.destroy()
      await container.stop()
    },
  }
}
