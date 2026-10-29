// pnpm run demo:local
//
// A local demo, nothing deployed and no AWS account: Anvil, DynamoDB Local and moto run in Docker, the real
// monitor cycle and the real actions dispatcher and sender run in this process against them, and the webhook
// lands on a catcher on 127.0.0.1. Every piece comes from the integration tests' own harness.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { CreateQueueCommand, DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs'
import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ANVIL_OWNER_KEY, loadArtifact } from '@blockwarden/contracts/testing'
import { compileRule, ruleInputSchema } from '@blockwarden/core'
import { GSI1 } from '@blockwarden/dynamo'
import { startDynamo } from '@blockwarden/dynamo/testing'
import { verifyWebhook } from '@blockwarden/relayer-client'
import type { DynamoDBRecord, SQSRecord } from 'aws-lambda'
import { createPublicClient, createWalletClient, getAddress, http, stringToHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { createChainReader } from '../../../services/monitor/src/chain.js'
import { runCycle } from '../../../services/monitor/src/cycle.js'
import { keys } from '../../../services/monitor/src/keys.js'
import { MonitorStore } from '../../../services/monitor/src/store.js'
import { startAnvil } from '../../../services/monitor/test/helpers/anvil.js'
import { DestinationError, type Resolved } from '../../../services/actions/src/destination.js'
import { dispatchRecords, type DispatcherDeps } from '../../../services/actions/src/dispatcher.js'
import { createLookup } from '../../../services/actions/src/lookup.js'
import { sqsDeliveryQueue } from '../../../services/actions/src/queue.js'
import { DEADLINE_MARGIN_MS, processMessages, type SenderPipelineDeps } from '../../../services/actions/src/sender.js'
import { sendWebhook } from '../../../services/actions/src/senders/webhook.js'
import { DeliveryStore } from '../../../services/actions/src/store.js'
import { startReceiver } from '../../../services/actions/test/helpers/receiver.js'
import { startMoto } from '../../../services/actions/test/helpers/store.js'
import { streamReader } from '../../../services/actions/test/helpers/stream.js'

const repo = new URL('../../../', import.meta.url)
const RULE_ID = 'demo-ping-42'
const RULE_URL = 'https://demo-receiver.example/hook'
const RULE_SECRET_PARAMETER = '/blockwarden/demo/webhook-secret'
const DEMO_SECRET = 'local-demo-secret-not-a-real-secret'
const PING_EVENT = 'event Ping(address indexed sender, uint256 indexed id, bytes32 tag)'

let stepNo = 0
const step = (title: string) => console.log(`\n[${++stepNo}] ${title}`)
const say = (line: string) => console.log(`    ${line}`)

function dockerReady(): boolean {
  const probe = spawnSync('docker info', { encoding: 'utf8', shell: true })
  return probe.status === 0
}

// deploy:local is the repository's own script: forge (from PATH or the pinned image) sends the CREATE2 deploys
function deployLocal(rpcUrl: string): void {
  const run = spawnSync('pnpm --filter @blockwarden/contracts run deploy:local', {
    cwd: repo,
    env: { ...process.env, RPC_URL: rpcUrl },
    encoding: 'utf8',
    shell: true,
  })
  if (run.status !== 0) {
    console.error(`${run.stdout}\n${run.stderr}`.split('\n').slice(-40).join('\n'))
    throw new Error('pnpm --filter @blockwarden/contracts run deploy:local failed')
  }
}

async function main(): Promise<void> {
  console.log(
    'Blockwarden local demo: everything runs on this machine. Nothing is deployed and no AWS account is used.',
  )
  if (!dockerReady()) {
    throw new Error('Docker is not running or not installed: start Docker Desktop (or the daemon) and run this again')
  }

  const started: { stop(): Promise<void> }[] = []
  let streamDestroy: (() => void) | undefined
  try {
    step('Starting Anvil, DynamoDB Local and moto (SQS) in Docker, and a webhook catcher on 127.0.0.1')
    const [anvil, dynamo, moto, receiver] = await Promise.all([
      startAnvil(),
      startDynamo(),
      startMoto(),
      startReceiver(),
    ])
    started.push(anvil, dynamo, moto, receiver)
    say(`Anvil ${anvil.rpcUrl} (chain ${anvil.chainId})`)
    say(`DynamoDB Local ${dynamo.endpoint}`)
    say(`moto ${moto.endpoint}`)
    say(`webhook catcher ${receiver.urlFor('/hook')}`)

    step('Deploying the demo contracts with deploy:local')
    deployLocal(anvil.rpcUrl)
    const deployment = JSON.parse(readFileSync(new URL('contracts/deployments/31337.json', repo), 'utf8')) as {
      emitter: Hex
    }
    const emitter = getAddress(deployment.emitter)
    const transport = http(anvil.rpcUrl)
    const reader = createPublicClient({ chain: foundry, transport, cacheTime: 0, pollingInterval: 100 })
    if ((await reader.getCode({ address: emitter })) === undefined) {
      throw new Error(`deploy:local reported DemoEmitter at ${emitter} but the Anvil above has no code there`)
    }
    say(`DemoEmitter at ${emitter}`)

    step(`Creating a monitor rule: ${PING_EVENT} where args.id == 42, webhook action`)
    const tableName = await dynamo.newTable()
    const store = new MonitorStore(dynamo.doc, tableName)
    const input = ruleInputSchema.parse({
      chainId: anvil.chainId,
      addresses: [emitter],
      event: PING_EVENT,
      conditions: { field: 'args.id', op: 'eq', value: '42' },
      confirmation: { mode: 'finalized' },
      actions: [{ type: 'webhook', url: RULE_URL, secretParameter: RULE_SECRET_PARAMETER }],
    })
    const warnings = compileRule(RULE_ID, input).warnings
    if (warnings.length > 0) throw new Error(`rule did not compile cleanly: ${JSON.stringify(warnings)}`)
    const now = new Date().toISOString()
    const chain = createChainReader([anvil.rpcUrl])
    const startBlock = await chain.getHead()
    await store.putRule({ ruleId: RULE_ID, input, active: true, createdAt: now, updatedAt: now })
    say(`stored rule ${RULE_ID} in table ${tableName}`)

    step('Calling ping() on DemoEmitter twice: id 7 (should not match) and id 42 (should)')
    const wallet = createWalletClient({ account: privateKeyToAccount(ANVIL_OWNER_KEY), chain: foundry, transport })
    const { abi } = loadArtifact('DemoEmitter')
    const tag = stringToHex('demo', { size: 32 })
    const pings: Record<string, Hex> = {}
    for (const id of [7n, 42n]) {
      const hash = await wallet.writeContract({ address: emitter, abi, functionName: 'ping', args: [id, tag] })
      await reader.waitForTransactionReceipt({ hash })
      pings[id.toString()] = hash
      say(`ping(${id}, "demo") in tx ${hash}`)
    }

    step('Running one monitor cycle (Anvil reports finalized as head minus 64, so mine 64 blocks first)')
    await anvil.mine(64)
    const result = await runCycle({
      chainId: anvil.chainId,
      chain,
      store,
      maxRange: 2000,
      timeBudgetMs: 60_000,
      startBlock,
    })
    say(`cycle ${result.status}: ${result.final} final match(es), ${result.provisional} provisional`)
    const { Items: matches = [] } = await dynamo.doc.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: GSI1,
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': keys.matchesByRule(RULE_ID) },
      }),
    )
    if (matches.length !== 1) throw new Error(`expected exactly one match for ${RULE_ID}, found ${matches.length}`)
    const match = matches[0]!
    if (match.transactionHash !== pings['42']) throw new Error('the match is not the ping(42) transaction')
    say(`MATCH rule=${String(match.ruleId)} status=${String(match.status)} block=${String(match.blockNumber)}`)
    say(`      tx=${String(match.transactionHash)}`)
    say(`      args=${JSON.stringify(match.args)}`)
    say(`      (ping(7) in tx ${pings['7']} was correctly ignored)`)

    step('Running the actions code path: DynamoDB stream -> dispatcher -> SQS -> sender -> webhook')
    const stream = await streamReader(dynamo.client, dynamo.endpoint, tableName)
    streamDestroy = () => stream.destroy()
    const deliveries = new DeliveryStore(dynamo.doc, tableName)
    const queueUrl = (await moto.sqs.send(new CreateQueueCommand({ QueueName: 'deliveries' }))).QueueUrl!
    const dlqUrl = (await moto.sqs.send(new CreateQueueCommand({ QueueName: 'deliveries-dlq' }))).QueueUrl!
    const queue = () => sqsDeliveryQueue(moto.sqs, queueUrl)
    const deadLetters = () => sqsDeliveryQueue(moto.sqs, dlqUrl)
    const dispatcherDeps: DispatcherDeps = {
      store: deliveries,
      lookup: createLookup(dynamo.doc, tableName, { ttlMs: 0 }),
      queue: queue(),
      deadLetters: deadLetters(),
      now: () => new Date(),
      ruleSecretPrefixes: ['/blockwarden/'],
      log: () => {},
    }
    // The guard refuses loopback on purpose, so as in the integration tests the destination is resolved to the
    // local catcher. It is still resolved from the URL the rule names, and any other URL is refused.
    const resolve = async (raw: string): Promise<Resolved> => {
      if (raw !== RULE_URL) throw new DestinationError(`the destination is refused: nothing in the demo serves ${raw}`)
      return {
        url: new URL(receiver.urlFor('/hook')),
        host: '127.0.0.1',
        address: '127.0.0.1',
        family: 4,
        port: receiver.port,
      }
    }
    const senderDeps: SenderPipelineDeps = {
      store: deliveries,
      queue: queue(),
      deadLetters: deadLetters(),
      senders: { webhook: sendWebhook },
      secrets: {
        read: async (name: string) => {
          if (name !== RULE_SECRET_PARAMETER) throw new Error(`no parameter named ${name}`)
          return [DEMO_SECRET]
        },
      },
      now: () => Date.now(),
      log: () => {},
      resolve,
      ses: moto.ses,
      fromAddress: 'alerts@example.com',
      random: () => 0.5,
    }

    // the stream trails the write by a moment, so read until it has records
    let records: DynamoDBRecord[] = []
    for (let wait = 10; wait <= 640 && records.length === 0; wait *= 2) {
      records = await stream.read()
      if (records.length === 0) await sleep(wait)
    }
    const dispatched = await dispatchRecords(dispatcherDeps, records)
    if (dispatched.batchItemFailures.length > 0) throw new Error('the dispatcher reported failures')
    say(`dispatcher read ${records.length} stream record(s) and queued the deliveries`)

    let handled = 0
    for (;;) {
      const { Messages = [] } = await moto.sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
      )
      if (Messages.length === 0) break
      const batch = Messages.map((m) => ({ messageId: m.MessageId!, body: m.Body! }) as SQSRecord)
      const { batchItemFailures } = await processMessages(senderDeps, batch, () => DEADLINE_MARGIN_MS)
      if (batchItemFailures.length > 0) throw new Error('the sender reported failures')
      for (const m of Messages) {
        handled++
        await moto.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle! }))
      }
    }
    say(`sender processed ${handled} queued delivery message(s)`)

    step('The delivery, as the local webhook catcher received it')
    const delivered = receiver.received.at(-1)
    if (!delivered) throw new Error('nothing reached the webhook catcher')
    const event = await verifyWebhook({
      payload: delivered.body,
      signature: delivered.headers['x-blockwarden-signature'] as string,
      secret: DEMO_SECRET,
    })
    say(`POST ${delivered.path}  (${receiver.received.length} request(s) received in total)`)
    say(`X-Blockwarden-Delivery: ${String(delivered.headers['x-blockwarden-delivery'])}`)
    say(`signature verified with verifyWebhook(): yes`)
    say(`event type: ${event.type}`)
    say(`event data: ${JSON.stringify(event.data)}`)

    console.log('\nDone. This was a local demo against Docker containers; nothing was deployed anywhere.')
  } finally {
    streamDestroy?.()
    await Promise.allSettled(started.map((s) => s.stop()))
  }
}

main().catch((err: unknown) => {
  console.error(`\ndemo:local failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
