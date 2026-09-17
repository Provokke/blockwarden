import { randomUUID } from 'node:crypto'
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda'
import { processRecords } from '../batch.js'
import { processTx, type SignerDeps } from '../signer.js'
import { createLogger, createRuntime, once } from './runtime.js'

const logger = createLogger('blockwarden-relayer-signer')

const deps = once<SignerDeps>(async () => {
  const runtime = await createRuntime(logger)
  return {
    store: runtime.store,
    chainFor: (chainId) => runtime.chains.get(chainId),
    accountFor: runtime.accountFor,
    queue: runtime.queue,
    now: () => new Date(),
    newTxId: randomUUID,
    // per container, so a cold start reconciles each signer's nonce with the chain before its first send
    reconciled: new Set(),
    log: runtime.log,
  }
})

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const signerDeps = await deps()
  return processRecords(event.Records, (txId) => processTx(signerDeps, txId), signerDeps.log)
}
