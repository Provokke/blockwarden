# Blockwarden design

Date: 2026-09-15
Status: approved for planning

Blockwarden is a self-hosted, serverless replacement for OpenZeppelin Defender's Monitor, Relayer and Actions, built for AWS. A team runs `terraform apply` in their own AWS account and gets:

- on-chain event monitoring with durable records from finalized blocks and fast provisional alerts from the chain head,
- a transaction relayer that signs with AWS KMS keys that never leave KMS,
- actions (webhooks, email, Telegram, relayed transactions) triggered by what the monitor sees,
- a dashboard with Sign-In with Ethereum.

It costs close to nothing while idle.

## Why this exists

OpenZeppelin shut down Defender on 1 July 2026 and open-sourced Monitor and Relayer as long-running services you host yourself. Nothing covers the case of a team that wants the same capability as scale-to-zero AWS infrastructure, with keys in their own KMS and one Terraform module to install it.

## Scope

### Goals for v1

- Monitor EVM mainnets: Ethereum (1), Base (8453), Arbitrum One (42161).
- Relay transactions on testnets: Base Sepolia (84532), Arbitrum Sepolia (421614). Mainnet relaying is a config change, not a code change, but the public demo never enables it.
- Delivery as a Terraform module a team deploys into its own account, plus one public demo instance run from the same module with tight quotas.
- Idle cost under $5/month for the demo instance.
- The relayer and the KMS signer are published as packages that two follow-up projects consume (see "Downstream consumers").

### Non-goals for v1

- Multi-tenant accounts, organisations or billing.
- Non-EVM chains.
- A hosted RPC. Operators bring their own RPC URLs.
- User-supplied code in rules or actions. Conditions are a declarative JSON language.
- AWS WAF, EKS or anything with a fixed monthly cost above a few dollars.

## Architecture

TypeScript throughout, using viem for chain access. Lambdas run on the Node.js 24 runtime (`nodejs24.x`, deprecation scheduled for 30 April 2028) on arm64, bundled with esbuild. Infrastructure is Terraform. Contracts are Foundry. CI/CD is GitHub Actions deploying to AWS through OIDC, with no long-lived AWS keys.

### Repository layout

```
blockwarden/
  packages/
    core/             pure logic: rule engine, match keys, adaptive log fetching, fee bump math, address and
                      URL classification, action schemas, shared types
    dynamo/           the shared DynamoDB document client and index names
    kms-signer/       viem LocalAccount backed by AWS KMS (secp256k1)
    relayer-client/   typed client for the relayer API and the webhook signature, used by downstream projects
  services/
    monitor/          poller Lambda: finalized durable scan and fast provisional scan
    actions/          dispatcher and reaper Lambda, sender Lambda, delivery store, channel senders, operator scripts
    relayer/          signer Lambda, sweeper Lambda
    api/              HTTP API handlers and the SIWE authorizer
  apps/
    dashboard/        Next.js static export
  contracts/          Foundry project
  infra/terraform/
    modules/blockwarden/   full stack: table, monitor, alarms, and the actions module
    modules/actions/       dispatcher, sender, queues and alarms; used by modules/blockwarden
    modules/relayer/       relayer only, for downstream projects
    envs/demo/
    envs/staging/
    examples/relayer-only/
    examples/monitor-actions-only/
  docs/design/
  docs/webhooks/      the published webhook payload, version 1
```

pnpm workspaces. `packages/core` has no AWS or network dependencies so it can be unit and property tested in isolation.

### Components

**Monitor.** EventBridge Scheduler invokes one poller per chain every minute, and a DynamoDB lease keeps a single poller active per chain. Each run does two scans. The durable scan reads logs from its cursor up to the chain's `finalized` block, so every match it writes is final and never needs retracting. The fast scan reads the unfinalized tail up to the head for rules in `fast` mode and writes provisional matches, which the durable scan later marks `final` or `dropped`. Final records trail the head by the chain's finality. Measured on 2026-09-15 through the official RPCs, that was about 19 minutes on Base and on Arbitrum. On Ethereum it is about 13 minutes by protocol design.

**Relayer.** `POST /v1/relayer/txs` validates the request against the signer's policy and enqueues it on an SQS FIFO queue with the signer id as the message group. The signer Lambda consumes the queue, so transactions for one signer are processed strictly in order. A sweeper Lambda runs every minute to track receipts, replace stuck transactions, requeue transactions that waited too long and resume paused signers. A transaction the node refuses after its nonce was reserved, when no node ever took any of its signatures, gets a filler transaction at that nonce, so later nonces are not blocked.

**Actions.** Two Lambdas. The dispatcher reads the DynamoDB stream for match and transaction status changes, writes a delivery item for each action the change fires, and enqueues it on SQS; the same function runs every minute as a reaper over a sparse due index, and reads the optional outbound queue. The sender consumes the delivery queue and carries all six channels — webhook, SES email, Telegram, a relayed transaction, an SQS queue and a Lambda function — in one function, because each extra function would need its own `Errors` alarm at $0.10 a month and would go cold between deliveries. A delivery that uses its attempts is marked dead and copied to a dead-letter queue, which is what the alarm watches.

**API and dashboard.** API Gateway HTTP API with a Lambda authorizer. The dashboard is a static Next.js export on S3. CloudFront serves both, routing `/v1/*` to API Gateway, so the session cookie is same-site.

**Contracts.** The demo deploys OpenZeppelin's `ERC2771Forwarder` and two contracts of our own on Base Sepolia and Arbitrum Sepolia:

- `DemoEmitter` emits events the nightly end-to-end test watches for.
- `TopUpVault` is `ERC2771Context`-aware and lets a relayed meta-transaction top up a balance, which the demo's "balance below threshold" rule triggers.

Solidity depth in this project is deliberately modest. The subscriptions project carries the heavier contract work.

## Data model

One DynamoDB table in on-demand mode, with TTL enabled and streams on (new and old images).

| Entity | PK | SK | Notes |
|---|---|---|---|
| Chain cursor | `CHAIN#<chainId>` | `CURSOR` | `durableBlock` (last finalized block scanned), `fastBlock` (last head the fast scan reached), `version` |
| Chain lease | `CHAIN#<chainId>` | `LEASE` | `owner`, `leaseUntil` (epoch milliseconds); one poller per chain |
| Rule | `RULE#<ruleId>` | `META` | GSI1: `CHAIN#<chainId>#RULES` / `RULE#<ruleId>`, set only while active |
| Match | `MATCH#<matchKey>` | `META` | status `provisional`, `final` or `dropped`; block number, block hash and log index where first recorded; a final record updates them; TTL 30 days; GSI1: `RULE#<ruleId>` / `<blockNumber>#<logIndex>`; GSI2 while provisional: `CHAIN#<chainId>#PROVISIONAL` / `<blockNumber>` |
| Delivery | `MATCH#<matchKey>`, `TX#<txId>` or `OUTBOUND#<requestId>` | `DELIVERY#<actionId>#<event>#<seq>` | channel, target, the exact bytes to send, status, attempts, next attempt time, last error and status code, `version` for optimistic writes; TTL 30 days; GSI1 while dead: `DELIVERY#DEAD` / `<createdAt>#<deliveryId>`; GSI2 while not terminal: `DELIVERY#DUE#<shard>` / `<nextAttemptAt epoch ms>` |
| Signer | `SIGNER#<signerId>` | `META` | KMS key id, chain ids, policy, `webhooks` (URLs subscribed to this signer's `tx.*` events) and the SSM name of their secret; written by Terraform and never changed at runtime. The address is derived from the key's public key, because Terraform has no keccak256 |
| Signer nonce | `SIGNER#<signerId>` | `NONCE#<chainId>` | `nextNonce`, taken in one DynamoDB transaction with the write that puts the nonce on the transaction |
| Signer pause | `SIGNER#<signerId>` | `PAUSE#<chainId>` | the balance the paused transaction needs and when the pause began; present only while paused |
| Spend counter | `SIGNER#<signerId>` | `SPEND#<chainId>#<yyyy-mm-dd>` | `spentGwei`, the worst-case cost reserved today (value plus gas limit at the policy fee cap), TTL 2 days |
| Transaction | `TX#<txId>` | `META` | kind (`relay` or `filler`), status, nonce, every signed attempt with its raw bytes and fees, the mined receipt, status history capped at the newest 64 entries with `historyBase` counting the ones dropped off the front so a delivery's `seq` keeps counting, `reference`, `dependsOn`, `version` for optimistic writes; GSI2 while unsettled: `TXPENDING#<chainId>` / `<createdAt epoch ms>` |
| Idempotency | `IDEMP#<apiKeyHash>#<key>` | `META` | maps to `txId`, TTL 24 hours; DynamoDB deletes up to about a day late, so a key can stay a duplicate for about 48 hours |
| API key | `APIKEY#<sha256>` | `META` | signer allowlist, label |
| SIWE nonce | `SIWE#<nonce>` | `META` | TTL 5 minutes |

`matchKey` is defined under "Match keys" below. Matches are created with `attribute_not_exists(PK)` and upgraded with a condition on their current status, which makes replays harmless.

GSI2 is sparse: an item only appears in it while it has work outstanding, so dropping stale provisional matches and the sweeper never scan.

## Rules

```json
{
  "chainId": 8453,
  "addresses": ["0x..."],
  "event": "event Transfer(address indexed from, address indexed to, uint256 value)",
  "conditions": { "all": [ { "field": "args.value", "op": "gte", "value": "1000000000000000000" } ] },
  "confirmation": { "mode": "finalized" },
  "actions": [ { "type": "webhook", "url": "https://example.com/hook" } ]
}
```

- `conditions` supports `all` and `any` groups, nestable, with ops `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in` and `contains`. Numeric comparisons parse both sides as bigint.
- `confirmation.mode` is `fast` (alert on the provisional match, then confirm or drop it) or `finalized` (alert only on the final match). A block-count mode is deliberately absent: a depth below finality can still reorg.
- Rules are validated on create and update: the event signature must parse, every condition field must exist in the event's ABI, and every action must pass its channel's schema. A field path is walked through the ABI's tuple components, so `args.permission.spender` is checked against the `spender` component of the `permission` tuple rather than only against `permission`; an index strips one array dimension, and `.length` is a number with no components of its own. `actions` is a discriminated union on `type`: `webhook`, `email`, `telegram`, `relay`, `sqs` and `lambda` each have their own strict schema, so an unknown field is a rejection rather than a setting that is silently dropped. Invalid rules are rejected with a field-level error.

## Data flow

### Poll cycle (per chain)

Each run takes the chain's lease, runs both scans inside a 50-second budget, and releases the lease. If another run holds the lease, it returns without touching the chain.

**Durable scan**

1. Read the chain's `finalized` block. A chain configured with `FINALITY_DEPTH` (for chains without the tag, typically 256) uses the head minus that depth instead. When `finalized` is unavailable and no depth is configured, the run skips the durable scan. It never guesses a depth, because a provider that normally supports the tag but errors once would otherwise send the durable scan into unfinalized blocks. The durable-lag alarm catches a persistent outage.
2. Fetch logs from `durableBlock + 1` to `min(finalized, durableBlock + maxRange)`, where `maxRange` defaults to 2,000 blocks, filtered by the union of addresses and topic0s across active rules.
   - **Halving.** When the RPC rejects a range, or answers with a body over 10 MB, halve it and retry, down to a single block. The next range starts at the size that last fitted. The size doubles again, up to `maxRange`, after a range that needed no halving. Once a range is refused after an earlier read in the same run fitted, that read's size caps the range for the rest of the run, so the size does not keep alternating between one that fits and a doubled one that is refused.
   - **Head check.** Each `eth_getLogs` is batched with `eth_blockNumber` in one HTTP request. The range only counts as read when that head is at or past its end; otherwise the run stops the durable scan and retries next time. Erigon, Besu and reth answer a range past their head with fewer logs instead of an error, so a lagging failover backend must not advance the cursor.
   - **Pre-read head.** Erigon also runs batch entries concurrently. So when the head a node last returned during this invocation is below the range end, a standalone `eth_blockNumber` goes to that node first, and its answer must reach the range end too. A node whose pre-read fails is skipped, and the range is not halved for it.
   - **Deadline.** Every request checks the invocation deadline first. Each sub-range of a halved range is saved as soon as it is read and written, and a run that reaches the deadline stops with the cursor at the last one. A request still running a few seconds before the Lambda timeout is aborted, and the run stops the same way.
3. Decode each log against every rule with the same address and topic0, and evaluate conditions. A log that fails to decode for a rule is not that rule's event (ERC-20 and ERC-721 `Transfer` share a topic0) and is skipped.
4. Write each match as `final`: create it, or upgrade a `provisional` or `dropped` record with the same key.
5. Save `durableBlock` conditioned on `version`, and repeat from step 2 until `finalized` is reached or the budget runs out.
6. Mark `dropped` every provisional match whose block is at least 64 blocks below `durableBlock`. The durable scan has passed its block without seeing it.

**Fast scan** (only when the chain has an active `fast` rule)

1. Scan from `max(durableBlock, fastBlock - 20)` to the head, at most 2,000 blocks per run, reading `maxRange` blocks at a time. When it is further behind, it skips ahead: the fast scan is best effort. The 20-block overlap catches logs that a shallow reorg moved.
2. Write each match as `provisional`, unless a record with the same key already exists.
3. Save `fastBlock` once, at the end of the last chunk read in full. It never moves behind its previous position, unless the head itself is below that position. Then a run that reaches the fast scan saves the head as `fastBlock` before it reads anything, so the cursor drops to the head even when the run stops before its first chunk. A run that stops for time before the fast scan leaves `fastBlock` where it was.

### Match keys

`matchKey` is `keccak256(chainId, transactionHash, ordinal, ruleId)`. `ordinal` is the log's position among the logs in the same transaction and block that match the same rule. A transaction's logs all sit in one block, so both scans compute the same key for the same event. The block is counted too because one fast-scan read can be several `eth_getLogs` responses (a halved range), and a reorg between them can return the same transaction in an orphaned block and in its new block; counted per transaction alone, the second copy would take ordinal 1 and become a provisional record for an event that never happened. The key leaves out the block, so a provisional record and its final record stay one item even when a shallow reorg re-includes the transaction in a different block.

Known limit: if a reorg changes which of a transaction's logs match (for example, it now emits a different number of them), the fast alert ends `dropped` and the final record arrives as a separate event.

### Dispatch

The dispatcher reads stream records and enqueues a delivery when:

- a match is created as `provisional` and its rule is in `fast` mode,
- a match becomes `final`, for rules in either mode (for a `fast` rule this confirms the earlier provisional alert),
- a match moves to `dropped` and its rule is in `fast` mode (a drop notice),
- a transaction item changes status, in which case it enqueues a `tx.<status>` delivery to each URL in the signer's `webhooks`.

A delivery is keyed under the item that caused it: `PK` is the match, the transaction or, for an outbound request, the caller's request id, and `SK` is `DELIVERY#<actionId>#<event>#<seq>`. `seq` is the index of the status-history entry that caused it, zero-padded to four digits so it sorts as a number; it is always `0` for a match. `actionId` is `a_` and the first 16 hex characters of a SHA-256 of the action canonicalised, so moving an action within a rule's list does not re-key its deliveries, and the delivery id is `dlv_` and the first 32 hex characters of a SHA-256 of the two key parts joined. The item is written with a conditional put, so stream redelivery does not create a second one.

Delivery is **at least once**, not exactly once. A crash between claiming a delivery and sending it, an SQS redelivery, or the reaper acting on a delivery whose attempt is still in flight all send the same body twice with the same delivery id. Receivers dedupe on `id` in the signed body; the `X-Blockwarden-Delivery` header carries the same value but is outside the signature, so a replay can rewrite it and it is only for tracing.

The dispatcher also runs on a one-minute schedule as a reaper. It queries a sparse `DELIVERY#DUE#<shard>` index, four shards taken from the delivery id, for anything whose next attempt time is more than 60 seconds past, and either queues it again or, once it has used its attempts, dead-letters it. That is what clears a delivery whose item was written but whose queue message was never sent, and a delivery whose sender died holding it: a claim leases a delivery for 120 seconds.

Webhooks are POSTed with `X-Blockwarden-Signature` and `X-Blockwarden-Delivery` (the delivery id, unsigned, for tracing; the same value is `id` in the signed body, which is what a receiver dedupes on). The signature header is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, and may carry several `v1` values while a secret rotates. The body is `{ id, type, createdAt, data }`, where `id` is the delivery id; for a `tx.*` event, `data` is the transaction as `GET /relayer/txs/{txId}` returns it. `verifyWebhook()` in `@blockwarden/relayer-client` checks the signature and a 300-second tolerance on `t`. A delivery id must be unique per status-history entry, not per transaction and status, so receivers do not drop the second `tx.mined` after a reorg as a duplicate.

### Relayer

1. `POST /v1/relayer/txs` takes `{ signerId, chainId, to, data, value?, gasLimit?, idempotencyKey, reference?, dependsOn? }`. `value` and `gasLimit` are decimal strings. `reference` is up to 128 characters of the caller's own, returned with the transaction.
2. The API checks the signer's policy, then runs `eth_estimateGas` from the signer's address. A call that would revert is rejected with 422 `estimate_reverted` and its raw revert data, before any nonce is reserved. Any other estimate refusal, geth's "gas required exceeds allowance" included, is 422 `estimate_failed`, and an RPC that is unreachable or rate-limits the call is 503 `rpc_unavailable`. These answers carry fixed messages, never the node's text, which can include the RPC URL. The policy has:
   - `allowedTo`: the contracts the signer may call, each with an optional function selector allowlist (`0x` allows a plain transfer) and, for an ERC-20, an optional list of the only recipients a `transfer` may send to, so a leaked API key cannot move collected tokens elsewhere. An entry with recipients must have exactly the `transfer` selector (`0xa9059cbb`) as its selector list, because `approve` or `transferFrom` would move the tokens anywhere. On an entry with selectors, calldata of 1 to 3 bytes is refused, since a contract's fallback would still run it. A `transfer` must re-encode byte for byte to be checked against the recipients, so dirty address padding or trailing bytes cannot pass as the transfer they look like,
   - a maximum gas limit and calldata of at most 8 KiB,
   - a fee cap (`maxFeePerGas`, `maxPriorityFeePerGas`) that every signature, replacements included, stays under,
   - a daily spend cap per chain. Each request reserves its worst case, value plus gas limit at the fee cap, so no number of replacements can exceed it.
3. It writes the transaction as `queued`, the idempotency record and the spend reservation in one DynamoDB transaction, then sends the transaction to SQS FIFO with group id `signerId` and deduplication id `<txId>-<enqueue count>`. A repeated `idempotencyKey` from the same API key returns the original transaction, and one with a different body is refused with 409. The comparison normalises decimal amounts, so `"00"`, `"0"` and an omitted `value` are the same request. A DynamoDB transaction conflict is retried with jitter; when the retries run out, the API answers 503 `busy`, which is safe to retry with the same idempotency key. The deduplication id is not the caller's key, because two API keys may pick the same key, and because the sweeper must be able to requeue inside SQS's five-minute window.
4. The signer Lambda:
   - reserves the next nonce and writes it onto the transaction in one DynamoDB transaction, after raising the counter to `eth_getTransactionCount(address, "pending")` on the first transaction for that signer and chain in each container,
   - builds an EIP-1559 transaction from current fee estimates, clamped to the policy fee cap,
   - asks KMS to sign the digest with `ECDSA_SHA_256`,
   - parses the DER signature into `r` and `s`, normalises `s` to the lower half of the curve order (EIP-2), and finds `v` by recovering against the signer's known address,
   - stores the raw signed transaction before sending it, so a crash after the send rebroadcasts the same bytes, then sends it with `eth_sendRawTransaction` and sets status `submitted`, recording on the attempt that a node took it (`acceptedAt`), which an unclassified answer or a timeout also counts as,
   - for a node that refuses the transaction outright (for example intrinsic gas too low), sets it `failed` and queues a filler, since a first send was never taken by a node: a 0-value transfer to itself at the same nonce, estimated like any transaction. A filler that is refused gets no filler of its own,
   - stops taking messages from a batch when less than one worst-case message's time remains before the Lambda timeout (`DEADLINE_MARGIN_MS`, 33 seconds of its 60), and hands the rest back to SQS. For the same reason, after giving up a nonce on `nonce too low` it hands the message back instead of signing at a fresh nonce when less than that remains; the reset is already saved, so the next delivery takes the fresh nonce. A malformed message, one that is not JSON or has no `txId`, fails every delivery, so it reaches the dead-letter queue instead of vanishing.
5. The sweeper queries GSI2 `TXPENDING#<chainId>` every minute:
   - A receipt for any signed attempt, or for a hash dropped to make room (see below), is found: set `mined` with the hash, block and whether it succeeded or reverted, then `confirmed` once the block is the chain's confirmation count deep (default 5, counting its own block). Confirmed transactions leave GSI2.
   - No receipt after the chain's stuck threshold (default 90 seconds since the last signature, or since the first send of it a node acknowledged, which covers a refused attempt taken on a rebroadcast and bytes saved before a crash), and this is the next nonce to be mined: re-sign the same nonce with each fee field raised to the greater of 12.5% over the newest attempt the node did not refuse, the current estimate and geth's replacement minimum (both fields at least 10% higher and strictly higher), capped at the policy fee cap. If the newest attempt is a refused replacement that already carried fees at least that high, the raise starts from it instead. A later nonce is not replaced while a lower one is outstanding.
   - Every attempt was refused, so none is in a mempool: sign a fresh attempt at the estimate clamped to the cap, with no replacement rule. An estimate whose `maxFeePerGas` is over the cap flags `feeCapReached` and is clamped the same way, since bytes at the cap can still be taken when the base fee dips. It is not signed when a refused attempt already carried fees at least as high in both fields, unless that refusal was at the cap and the new fees are under it, which is how a transaction refused during a spike recovers. Instead the highest such attempt that still has its raw bytes is rebroadcast, since the base fee may have fallen below it; one the node takes counts as live again, and its stuck clock starts over. If none has its bytes, one attempt is signed at the highest refused fees. A fresh attempt refused outright is handled as a refused rebroadcast, below. An accepted replacement or fresh attempt clears `feeCapReached`.
   - The cap is below the replacement minimum, or 10 attempts the node did not refuse have been signed: no replacement is possible. A refused attempt never reached a mempool, so it does not count. The transaction is flagged `feeCapReached`, logged once, and its newest unrefused attempt is rebroadcast when the node no longer has it. The pending-age alarm fires if it never mines.
   - A node that forgot a transaction, or a crash between saving an attempt and sending it: the newest attempt the node did not refuse is rebroadcast.
   - A receipt disappears or moves to another block after a reorg: set back to `submitted` and rebroadcast the stored raw transaction.
   - Every send, rebroadcast and receipt marks the attempt as taken by a node (`acceptedAt`), and a dropped attempt that was taken sets `retiredAccepted`. A rebroadcast, replacement or fresh attempt refused outright fails the transaction and queues a filler only when no signature at the nonce, stored or dropped, was ever taken and none is still unanswered, the same rule as the signer's first send. Otherwise a taken signature may still be mined, and a filler would hit nonce too low while a retry ran the payload twice, so the attempt is only marked refused and the transaction stays `submitted`: a receipt for any hash marks it mined, a nonce used by none of our hashes fails it as below, and while the nonce stays unused the fresh-attempt rule above signs or rebroadcasts again once it is stuck. Insufficient funds pauses the signer; underpriced marks it for replacement on the next sweep.
   - The nonce is used but no receipt matches any of our hashes: set `failed` once the confirmation count of blocks and at least 10 minutes have passed since the nonce first read as used, and a receipt lookup against every RPC URL finds none of our hashes with no URL erroring. A lagging node can show a used nonce for a while, so the marker clears if the nonce reads as unused again. No filler is sent. A key used outside the relayer does this, and a filler says so differently, because a filler's nonce is normally taken by the transaction it fills. Once that wait is over the all-URL lookups are the only ones a sweep makes, since they cover every hash the per-sweep lookups do.
   - A replacement refused for insufficient funds pauses the signer, as a refused first send does.
   - At most 16 attempts keep their raw bytes on the item, which DynamoDB caps at 400 KB. Past that, the oldest refused attempts keep only their hash, which is all a receipt lookup needs. At 64 stored attempts, a new signature takes the place of the oldest refused attempt, preferring one already without its bytes; an attempt the node did not refuse is never dropped. Stored bytes are still rebroadcast at the limit. A dropped attempt's hash moves to `retiredHashes`, because a node may have taken it before refusing it: its receipt is looked up on every sweep once the nonce reads as used, and before a used nonce fails the transaction. At about 70 bytes each, the 512 retired hashes kept at most add about 36 KB, so 16 signed attempts with calldata (about 290 KB), 48 hash-only attempts (about 22 KB), 4 abandoned attempts (about 2 KB), a full `retiredHashes` and 68 refusal messages (about 18 KB) stay near 355 KB. A node's answer is stored and logged as at most 256 characters with a trailing `...`, since some echo the whole raw transaction back: a 16 KB answer on every attempt would put the item past 1.3 MB, which DynamoDB refuses, and after that the transaction could not even be marked failed. Once it is full, no retired hash is dropped: a signature that needs room is not made, the transaction is flagged `retiredHashesFull` and logged once, and stored bytes are still rebroadcast as fees fall. The pending-age alarm fires if it never mines.
   - **Receipt lookups per sweep.** A transaction at those limits holds 576 hashes, so each transaction gets an equal share of what is left of the sweep deadline for its lookups: a page of two splits what remains in half. Hashes are walked newest first, stored ones before dropped ones, and a walk that runs out of its share stops without deciding anything and saves how far it got in `lookupFrom`, so the next sweep carries on from there instead of starting over. The two walks, the per-sweep one and the all-URL one before failing, count separately, and a finished walk clears the marker so the next one starts at the newest hash again. Without that share one transaction with hundreds of hashes would use a whole sweep and starve the rest of the page; without the resume point it would never reach the end of its own hashes. Before an all-URL walk that resumed from a marker fails the transaction, it asks every URL again for the stored attempts, newest first: a node that lagged when those hashes were walked may have caught up since, and only a walk done in one sweep saw them all at one moment. Those at most 64 calls continue the same marker, so a re-check cut short carries on next sweep and decides nothing.
   - A queued transaction sat for 10 minutes: send it to the queue again. A paused signer's transactions wait instead, and once its balance covers the transaction that paused it, the pause is cleared and its queued transactions are requeued, lowest nonce first.

   The sweeper pages through every pending transaction, so one signer's backlog does not hide another's. An error on one transaction is logged and counted, and the sweep moves on. Chains are swept in parallel against a hard stop 3 seconds before the Lambda timeout. The invocation fails if any chain failed or did not finish, or any transaction errored, so the function's Errors alarm fires.
6. A transaction with `dependsOn` names an earlier `txId` of a signer the same API key may use, on the same chain, and must carry `gasLimit`. It is not estimated when submitted. The signer leaves it queued, without a nonce, until the dependency is `confirmed`. Then it runs the estimate: a revert, or any other refusal (an unreachable RPC is retried instead), fails it without taking a nonce. The revert payload is stored in the error the same 256 characters at a time as a node's answer, since the node chooses how long it is; a 422 from the API still carries the whole of it. A dependency that fails, or is confirmed as reverted, fails the dependent transaction too. The sweeper requeues it once when the dependency settles.

Status values: `queued`, `submitted`, `mined`, `confirmed`, `failed`, `cancelled`. `cancelled` is reserved for a cancel operation that no route offers yet. Every status change is appended to the transaction's history and arrives on the table stream. Milestone 3 turns each new history entry into a `tx.<status>` delivery to every URL in the signer's `webhooks`, so relayer users subscribe by webhook instead of polling.

## HTTP API

All routes are under `/v1`. Dashboard routes need a SIWE session. Relayer routes accept a session or an API key in `Authorization: Bearer <key>`. Milestone 2 ships the three relayer routes below that say so, with API keys only, on their own API Gateway HTTP API in `modules/relayer`; milestone 4 adds sessions and the rest. The two delivery routes are milestone 4 as well: milestone 3 ships the `delivery:list` and `delivery:redrive` scripts in `services/actions` instead, which an operator runs against the table with AWS credentials.

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/siwe/nonce` | issue a nonce |
| POST | `/auth/siwe/verify` | verify the message and signature, set the session cookie |
| POST | `/auth/logout` | clear the session |
| GET, POST | `/rules` | list, create |
| GET, PATCH, DELETE | `/rules/{ruleId}` | read, update, delete |
| GET | `/matches?ruleId=&cursor=` | match history |
| GET | `/deliveries?status=&cursor=` | delivery history (milestone 4) |
| POST | `/deliveries/{deliveryId}/redrive` | resend from the dead-letter queue (milestone 4) |
| GET | `/relayer/signers` | signers the key may use, with their addresses (milestone 2) |
| POST | `/relayer/txs` | submit (milestone 2) |
| GET | `/relayer/txs/{txId}` | status (milestone 2) |
| GET | `/relayer/txs?status=&cursor=` | list |
| GET | `/health` | per-chain cursor lag, queue depth |

Sessions are HS256 JWTs in an `HttpOnly; Secure; SameSite=Strict` cookie, 12-hour lifetime, signed with a secret from SSM Parameter Store. The dashboard's allowed wallets are an allowlist in Terraform variables.

## Downstream consumers

Two follow-up projects depend on this one, so these interfaces are treated as public and versioned with semver from the first release:

- **`@blockwarden/kms-signer`** exports `toKmsAccount({ keyId, region?, client? })`, resolving to a viem `LocalAccount` that implements `sign`, `signTransaction`, `signMessage` and `signTypedData`. It reads the public key once and keeps the address, and accepts an existing KMS client. It refuses blob transactions, including an untyped transaction viem infers as one from its blob fields, and a digest that is not 32 bytes. `@blockwarden/kms-signer/testing` exports `createLocalDigestSigner(privateKey)`, an in-memory key behind the same interface, which returns DER with high `s` about half the time as KMS does, for downstream integration tests. The gas-sponsorship project uses `signTypedData` for paymaster approvals.
- **`@blockwarden/relayer-client`** exports `relay()`, `getTx()`, `listSigners()`, `verifyWebhook()`, `signWebhook()`, `isTxEvent()` and `parseTx()`. 0.2.0 adds `isMatchEvent()` for the `match.*` events milestone 3 sends, `toDecodedValue()` for the decimal-string form every integer in a decoded argument takes on the wire, `MATCH_STATUSES`, `WEBHOOK_SPEC_VERSION`, and `revertData` on a transaction; everything added is additive, and nothing existing changed shape. A transaction reports `receiptStatus` (`success` or `reverted`), `hash` and `blockNumber`, and a 422 from a reverting estimate carries `revertData`. `verifyWebhook()` refuses an empty or non-string secret and a tolerance that is not a finite, non-negative number. `relay()`, `getTx()` and `listSigners()` reject only with `RelayerApiError`, whose codes include `network_error` (status 0), `invalid_response` and `throttled`. Every API key allowed a signer can read that signer's transactions. The subscriptions project uses it to call `charge()` each billing period.
- **`modules/relayer`** is a Terraform module that deploys only the relayer, signer keys and sweeper, so a downstream project does not have to deploy the monitor. It creates its own table and alarm topic unless given the full stack's. Its variable validations mirror the relayer's runtime schemas, so a policy the relayer would refuse fails at plan. It takes signers with their policies, webhook URLs and webhook secret parameter, and optional API keys, which it stores in SSM. It outputs the API URL, the signer key ARNs and the API key parameter names; signer addresses come from `GET /relayer/signers`.

## Error handling

**RPC**
- Each chain has an ordered list of RPC URLs with failover. The relayer refuses more than 3 per chain at startup, since past 3 the signer's per-call timeout would hit its 1 second floor and the worst message would outgrow its budget.
- The relayer tries each URL once per call, with a timeout sized so a hung URL cannot use up the function: the API splits 12 seconds over its URLs (1 to 4 seconds each), and the sweeper splits 20 seconds (1 to 4 seconds each).
- The signer's timeout is derived from its own Lambda timeout rather than a fixed budget. Of its 60 seconds, 6 are kept for the ten or so AWS round trips a message makes and the rest splits in two: 27 seconds of RPC for one message, and a 33 second batch margin, which has to hold a whole message because a message may start with only the margin left. The worst message makes 7 calls (a `dependsOn` estimate, the cold nonce read, three for the fee estimate, the send, and the receipt check a `nonce too low` answer costs), so each call gets `clamp(27000 / (7 × urls), 1000, 2500)`: 2,500 / 1,928 / 1,285 ms for 1 / 2 / 3 URLs. At 3 URLs all hung that is 26,985 ms, inside the 27 seconds, and the 1 second floor no longer binds. The RPC calls fill that budget at 2 URLs, so the 6 seconds is the only slack: at about 600 ms a round trip it absorbs a throttled write the SDK retries. viem has no minimum of its own: it arms the timer for any positive timeout. The queue's visibility timeout is six times the function timeout, 360 seconds.
- The durable log read sends `eth_blockNumber` and `eth_getLogs` as one batch to one node and fails over the pair together, so a head and its logs always come from the same node.
- A failed cycle never advances the cursor past blocks that were not fully read and written; the next invocation resumes.
- An alarm fires when the durable scan falls more than a per-chain threshold behind the finalized block (default: 50 blocks on Ethereum, 300 on Base and Arbitrum).
- An alarm fires when the RPC's `finalized` block is more than 60 minutes old. On 2026-09-15 one public provider reported `finalized` about 17.8 hours stale on Base and Arbitrum.

**Rules**
- A stored rule that no longer compiles at all - an event signature that will not parse, a condition naming an
  input the event does not have - is skipped and logged at warn, and polling continues for every other rule. The
  `ruleSkips` metric counts it, so an alarm can watch for a rule that has quietly left the poll.
- Anything else wrong with a rule is a warning rather than a refusal: an action that fails its channel schema is
  dropped and the rule keeps matching and keeps delivering its other actions, and a condition path that reaches
  deeper than the event carries is kept and simply never matches. Both are logged at warn and counted by
  `ruleWarnings`. Validation a rule was written before cannot be allowed to take a live rule off the poll; the
  write paths (`rule:put`, the Terraform `rules` validation) refuse the same things outright instead.

**Actions**
- Eight attempts, then the dead-letter queue. The step before attempt *n* is `min(10 × 3^(n-1), 900)` seconds, 900 being the longest delay SQS accepts. Each wait is then jittered: the band is 40% of the step wide and its top is `min(step × 1.2, 900)`, so it hangs below the cap rather than being clipped onto it — jittering around 900 and clamping would put every draw in the top half of the band on exactly 900, and a herd that failed together would come back together on the attempts that matter most. That gives about 10, 30, 90 and 270 seconds, and from the fifth attempt 9 to 15 minutes. A delivery that never succeeds is dead about 43 minutes after it was made, 33 to 53 minutes across the jitter band.
- A `Retry-After` on a 429 or a 5xx, and Telegram's `parameters.retry_after`, can only lengthen a wait. A destination asking for less than the backoff is not honoured, or the last attempts would become a hot loop against a server that is already struggling.
- A webhook response of 4xx other than 429 is not retried. Neither is a 3xx: a redirect is never followed, so it is permanent too, and the delivery is dead-lettered at once.
- A dead delivery is both `status: dead` on its item and a message on the dead-letter queue, which is what the alarm watches. Milestone 3 ships `delivery:list` and `delivery:redrive` scripts; the dashboard's redrive button is milestone 4.

**Relayer**

| Condition | Handling |
|---|---|
| estimate reverts | reject with 422 and the revert data before reserving a nonce |
| `nonce too low` | if a receipt exists for one of the transaction's hashes, it was mined. Otherwise, if this run reserved the refused nonce, nothing was sent at it before: give it up, keep the newest 4 abandoned signatures as evidence (hash, fees, nonce and the refusal, without the raw bytes), reconcile from chain and sign at a fresh nonce, at most twice before SQS retries the message. If an earlier run held the nonce, its bytes may be mined where the receipt read missed them, so set `submitted` and leave it to the sweeper instead of signing the payload again at a new nonce |
| `replacement transaction underpriced`, or a fee below the base fee | mark the attempt refused and let the sweeper replace it on its next run |
| `insufficient funds` | pause the signer on that chain and leave its transactions queued; the pending-age alarm fires, and the sweeper resumes the signer once its balance covers the transaction |
| refused for any other known reason (intrinsic gas, block gas limit, chain id, fee cap) | fail the transaction and queue a filler at its nonce, unless a node took one of its signatures (the sweeper's rule; a first send has none) |
| KMS throttling | the SDK retries with backoff; then the message is handed back, and the failed message and every later message in its group return to SQS, so FIFO order holds |
| a node gives no definitive answer to a send or an estimate: a transport failure, a rate limit, or an internal, unsupported-method or unrecognised error | try the next RPC URL; a refusal the relayer recognises, or a revert, is final for that call |
| RPC timeout or an unclassified answer after send | treat as possibly sent; the sweeper resolves it by hash |
| DynamoDB transaction conflict | retry with jitter; when the retries run out, the API answers 503 `busy` and the signer hands the message back to SQS |
| a message fails 5 times | it moves to the dead-letter queue, which alarms; the transaction stays queued in the table and the sweeper requeues it |

## Security

- **KMS.** The key policy allows `kms:Sign` and `kms:GetPublicKey` only to the signer and sweeper Lambda roles, and `kms:GetPublicKey` alone to the API role, which needs each signer's address. Keys are non-exportable. CloudTrail records every signature.
- **IAM.** One role per Lambda, scoped to the exact table, queues and keys it uses. Generated by Terraform, no wildcards on resources.
- **API keys.** Stored as SHA-256 hashes, each carrying its own signer allowlist. A key Terraform creates is also in Terraform state and in an SSM SecureString; a key the `apikey:create` script creates is printed once.
- **SIWE.**
  - The server checks domain, URI, nonce (single use, 5-minute TTL), chain id and expiry.
  - Smart contract wallets are verified through EIP-1271 using viem's `verifyMessage`.
- **Webhooks (SSRF).** The guard runs twice: once on the URL — when the rule is compiled, since this milestone has no rule-create route to check it at write time (milestone 4 adds one), or when an outbound request is accepted — and once on the resolved addresses when the delivery is sent.
  - The URL must be `https`, must carry no username or password, and must not use port 0, which a client turns back into 443 without saying so. A URL whose host is already a literal address is classified there and then. Every spelling of an address normalises through `URL` first, so `0x7f.1`, `127.1` and `2130706433` are all `127.0.0.1`.
  - At send time the host is resolved and **every** returned address must pass. Refused: `0.0.0.0/8`, `10/8`, `100.64/10` (carrier-grade NAT), `127/8`, `169.254/16` (which is where `169.254.169.254` lives), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24` (the 6to4 relay anycast prefix), `192.168/16`, `198.18/15` (benchmarking), `198.51.100/24`, `203.0.113/24`, `224/4` and `240/4`; and in IPv6 `::/64`, `64:ff9b::/96` (NAT64), `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, `2001::/32`, `2001:db8::/32` and `2002::/16`. An IPv4-mapped address is judged as the IPv4 address it wears.
  - The connection is then pinned to the address that passed, through the request's own `lookup`, with `agent: false` so no pooled socket can skip it, so a name that answers differently a moment later cannot move it. The certificate is still checked against the name. `node:https` is used rather than `fetch`, which ignores a `lookup` option and so cannot pin at all.
  - Redirects are not followed; a 3xx is a permanent failure.
- **Secrets.** RPC URLs, the JWT secret, webhook HMAC secrets and the Telegram bot token live in SSM Parameter Store as SecureString parameters. RPC URLs can hold provider API keys, so the relayer keeps them out of its logs and thrown errors. A name the caller chooses is checked against a prefix list before it is read, because the sender would otherwise sign a body of the caller's choosing with whatever secret was named and post the result anywhere: `rule_secret_prefixes` for a rule's own webhook action, `outbound_secret_prefixes` for an outbound request. They are separate lists, and the IAM grant is built from the same prefixes plus a `/`, so a prefix names a level of the hierarchy rather than a run of characters. The relayer API URL must be https, since the API key travels on every request.
- **Demo abuse.**
  - API Gateway route throttling, plus per-wallet quotas in DynamoDB: 5 rules and 20 relayed transactions per day.
  - Relaying is testnet-only, and the signer's daily spend cap is enforced in policy.
- **Supply chain.**
  - pnpm lockfile committed, Dependabot enabled.
  - gitleaks runs in CI.
  - Slither runs on contracts in CI.

## Testing

**Unit (Vitest), in `packages/core` and each service**
- Property tests with fast-check for:
  - scanning: for any sequence of reorgs above finality, flaky headers, crashes and save conflicts, the final match set equals the canonical finalized match set, and every provisional match ends `final` or `dropped`,
  - condition evaluation against bigint edge cases,
  - fee bump math: every replacement satisfies the node's minimum bump,
  - DER parsing and `v` recovery, against DER signatures OpenSSL makes with a local secp256k1 key,
  - the KMS-backed account signs byte for byte as viem's private key account does.

**Contracts (Foundry)**
- Unit, fuzz and invariant tests.
- Invariants include: a forwarder request cannot be replayed, and `TopUpVault` balances never exceed deposits.

**Integration (Docker: Anvil, DynamoDB Local and moto server for SQS; the LocalStack repository is archived)**
- `anvil_reorg <depth> <txs>` produces real reorgs; the test asserts a `fast` rule's provisional match becomes `dropped` when its log is reorged away, and `final` when the log is finalized.
- `anvil_dropTransaction` simulates a stuck transaction; the test asserts the sweeper replaces it at the same nonce.
- SQS FIFO ordering and deduplication run against moto server 5.2.3, which was measured to keep FIFO order, deduplicate, and block a group while a message is in flight.
- The relayer end-to-end test runs `@blockwarden/relayer-client` against the API handler, moto, the signer, Anvil and the sweeper: confirmation, signing order, idempotency, revert data, a reverted receipt, a dropped transaction replaced at its nonce, a reorged receipt, a filler after a refused transaction, a paused and resumed signer, nonce reconciliation and a dependent transaction.
- The actions end-to-end test drives the whole pipeline off DynamoDB Local's own stream, read with `@aws-sdk/client-dynamodb-streams`: a match row and a transaction row are written, the dispatcher turns the stream records into deliveries, and the sender delivers them to a local receiver and to moto's SES v2 and SQS. It asserts that the webhook verifies with `verifyWebhook()` against the secret that delivery's own action names, that a reorged transaction sends two `tx.mined` deliveries with different ids, and that a delivery which keeps failing dies, lands on the dead-letter queue and goes again after a redrive that also clears the copy. The destination guard is the one piece it stands in for — `127.0.0.1` is refused on purpose, so the test resolves the destination itself — and the guard has its own integration test against a self-signed HTTPS server.
- The end-to-end test wires only the webhook and email channels into the sender; telegram, relay, sqs and lambda deliveries never run through it, and neither does the outbound queue's acceptance path. Telegram, sqs and lambda each have their own integration test against a real receiver, moto SQS or a real Lambda client (`telegram-sender.test.ts`, `aws-sender.test.ts`); `sendRelay` has no integration test at all, only unit tests against a fake relayer client (`relay-sender.test.ts`).
- Two things DynamoDB Local cannot show, so they are covered elsewhere: it suppresses a `MODIFY` for a write that changes nothing, which real DynamoDB does not promise, so the dispatcher's idempotence is proved by its conditional put in the integration test rather than by the absence of a record; and it never expires a TTL item, so no TTL `REMOVE` record is ever produced, and that the dispatcher ignores every `REMOVE` is a unit test.
- Two branches the end-to-end test does not reach, both covered only by unit tests against fakes: the reaper's own dead-letter branch, where a sweep finds a delivery that has used all eight attempts and sends the dead-letter copy before marking it dead; and the dispatcher's skip of a stream record it cannot read, which reports that record alone as a batch item failure and lets the rest of the batch through. The end-to-end test does reach the reaper's requeue branch, and the sender's dead-letter path, which is a different piece of code from the reaper's.
- KMS signing: moto 5.2.3 hashes a `DIGEST` message again before signing (0 of 20 signatures recovered against the digest, 20 of 20 against its SHA-256), so integration tests use the in-process secp256k1 signer behind the same interface. One test signs against a real KMS key and runs only when `BLOCKWARDEN_KMS_TEST_KEY_ID` is set.

**Infrastructure**
- `terraform fmt -check`, `terraform validate`, tflint and checkov on every pull request, over three roots: `envs/demo`, which uses every module, and the two examples, each of which deploys one slice on its own defaults.
- The module's variable validations mirror the runtime schemas they stand for — the target ARN allowlist, the SSM parameter names and prefixes, a signer's policy — so a value the code would refuse at cold start fails at plan instead.
- `terraform plan` output posted as a PR comment.

**End to end (nightly GitHub Actions)**
1. Deploy `envs/staging` through OIDC.
2. Create a rule on Base Sepolia watching `DemoEmitter`, emit an event, assert the webhook arrives with a valid signature.
3. Relay a `TopUpVault` top-up, assert it reaches `confirmed`.
4. Leave the stack running; it costs close to nothing idle.

## Observability

- **Logs.** Structured JSON logs through Powertools for AWS Lambda (TypeScript), with a correlation id carried from match to delivery and from API request to transaction. `POWERTOOLS_LOG_LEVEL` sets the level on both actions functions, from the module's `log_level` input.
- **Metrics** (CloudWatch embedded metric format): durable lag and finalized block age per chain, matches per rule (still deferred from milestone 1, and not emitted yet), `pendingAgeSeconds` (the oldest unsettled relayed transaction) per chain, and `signerBalanceGwei` per signer and chain for signers with a balance alarm. Actions adds `deliveriesDead`, published by the sender when a delivery dies and by the reaper when a sweep kills one, and `deliveryBatchFailures`, published when the sender hands part of an SQS batch back. Both are billed custom metrics, so each is published only when it happens, and neither carries a channel dimension: six channels would be six billed metrics instead of one. Dead-letter depth is not a custom metric — SQS publishes it.
- **Alarms** go to SNS email: durable lag, finalized block older than 60 minutes, relayer pending age (which covers a paused signer, a fee cap below the replacement minimum and a stuck nonce), signer balance below threshold, relayer function errors, the relayer sweeper not invoked for 10 minutes, API 5xx responses, and the relayer's dead-letter depth. Actions adds four: `ApproximateNumberOfMessagesVisible` above zero on the delivery dead-letter queue, the same on the stream-failure queue that holds batches Lambda gave up on, and an `Errors` alarm on each of the dispatcher and the sender. A fifth watches the outbound dead-letter queue when `outbound_queue` is set. No alarm watches `deliveriesDead` or `deliveryBatchFailures` directly; the dead-letter alarm above is what pages when a delivery dies, whether or not that same event also incremented the metric.

## Known limitations

As of milestone 3:

1. **Delivery is at least once.** A crash between claiming a delivery and sending it, an SQS redelivery, or the reaper acting on a delivery whose attempt is still in flight all send the same body twice with the same delivery id. Receivers dedupe on `id` in the signed body, not on the unsigned `X-Blockwarden-Delivery` header.
2. **The reaper's grace is 60 seconds and the claim lease is 120.** A sender that takes longer than the lease can have its delivery re-enqueued underneath it, which is one of the ways the line above happens.
3. **A webhook action with no secret at all is refused with nothing sent.** `secretParameter` is optional on a webhook action and `WEBHOOK_SECRET_PARAMETER` is optional on the deployment. When an action names neither, the delivery is created, refused permanently on its first attempt, marked dead and copied to the dead-letter queue, so the alarm fires and the sender logs it — but nothing is sent and no retry can help. Neither setting can be made mandatory on its own without breaking a legitimate deployment: a deployment whose webhook actions all name their own parameter, or that has no webhook actions at all, needs no default, and a rule author cannot know from the rule whether the deployment has one. The pairing is only knowable where the sender already checks it, at delivery time. An outbound request is different — `secretParameter` is required by its schema, because there is no rule behind it to carry one.
4. **The dead-letter copies a redrive leaves behind.** `delivery:redrive` deletes the copies of the deliveries it redrove only when it is given `--dlq`. Without it they expire with the queue's retention and the alarm stays on until they do, which is the safe default: draining a queue an operator has not read yet loses what is on it.
5. **A rule Terraform writes is validated only as far as HCL can.** `conditions` and each action are JSON strings, so the module checks what it can; past that, the monitor and the dispatcher drop the part of a rule that does not compile, log it at warn and go on with the rest. A bad rule is silent except in the log and the `ruleSkips` and `ruleWarnings` metrics.
6. **The Telegram 429 shape is from Telegram's documentation, not measured.** Only the 401 and 404 shapes were seen, because the rest needs a real bot token. A missing `parameters.retry_after` falls back to the sender's own backoff, so a wrong guess about the field name costs a longer wait and nothing else.
7. **The stream filter matches `SK = META` exactly.** `prefix` is not documented for DynamoDB event source filters, so items like `RULE#`, `SIGNER#` and `IDEMP#` still reach the dispatcher and are dropped in code. The same code also drops anything whose sort key is not `META`, which is what keeps a delivery — which shares its partition key with the match it belongs to — from causing a delivery of its own.
8. **A delivery whose rendered payload is larger than 64 KiB is refused.** `MAX_PAYLOAD_BYTES` in `services/actions/src/records.ts` is 64 KiB. A match- or transaction-triggered delivery is checked when the dispatcher writes the delivery item (`DeliveryStore.create`); going over it there is treated as a poison record and skipped rather than retried, because the same oversized bytes come back every time. An outbound request is checked separately, at accept time, before any delivery item exists. Either way nothing is ever sent for that delivery.

## Cost estimate (demo instance, idle)

These are estimates from published AWS pricing and have to be measured after the first deploy.

| Item | Estimate |
|---|---|
| Lambda: 3 pollers and 1 sweeper at 1/min, about 173k invocations/month | within the always-free 1M requests and 400k GB-seconds |
| EventBridge Scheduler | within free invocations |
| DynamoDB on-demand, small table | under $1 |
| SQS | within the 1M free requests |
| KMS: $1 per signer key per month; the demo has 1 signer, from milestone 2 | about $1 |
| API Gateway HTTP API | cents at demo traffic |
| CloudFront, S3 | within free tier at demo traffic |
| SSM standard parameters | free |
| DynamoDB Streams | free: AWS does not charge for `GetRecords` calls made by a Lambda trigger |
| SQS: the delivery queue, its dead-letter queue, the stream-failure queue, and the optional outbound pair | within the 1M free requests at demo traffic |
| Lambda: the dispatcher at 1/min plus a few stream batches, and the sender per delivery | within the always-free 1M requests and 400k GB-seconds |
| SES | a new account defaults to the Essentials plan at $0.16 per 1,000 emails, since AWS closed the SES-specific free tier to new customers on 21 July 2026; à la carte pricing, $0.10 per 1,000, has to be chosen explicitly (cancel the plan in the SES console). This estimate uses à la carte. Either way, nothing while idle |
| CloudWatch alarms: 9 for the monitor, 10 for the relayer on 2 chains with 1 signer, and, from milestone 3, 4 for actions (delivery dead letters, stream failures, and an `Errors` alarm on each of the two functions) — 5 with the outbound queue. 23 in all | the first 10 alarm metrics are free (one metric per alarm here, so 10 alarms), then $0.10/alarm/month, so $1.30 |
| CloudWatch custom metrics: up to 5 per monitored chain. `durableLag` and `finalizedAgeSeconds` are emitted on most runs. `deadlineSkips` is emitted whenever a run stops for time, which includes normal catch-up after a start block or an outage. `busySkips` and `laggingNodeSkips` are emitted only when they occur. Across 3 chains that is up to 15 metrics. The relayer adds `pendingAgeSeconds` per chain and `signerBalanceGwei` per signer per chain: 4 more. Milestone 3 adds `deliveriesDead` and `deliveryBatchFailures`, published only when they happen: 2 more, so 10 in a month where nothing skips and nothing dies, and up to 21 | the first 10 are free, then $0.30/metric/month, so nothing to $3.30 |
| **Total** | **about $2.40 to $6.60 per month:** KMS about $1, DynamoDB under $1, alarms $1.30, custom metrics nothing to $3.30. The upper end is above the $5 goal and needs every occasional monitor metric, and a failed delivery, in the same month |

The fast scan adds one `eth_getLogs` call per run on each chain that has `fast` rules.

Milestone 3 raised the ceiling: it adds $0.40 a month that is always charged (four alarms, all of them past CloudWatch's free ten) and up to $0.60 more in a month where a delivery dies or a stream batch fails, so up to $1.00 in all, and $0.10 more again with `outbound_queue`. The plan for milestone 3 estimated $0.30 to $0.40 of alarms because it counted three; the stream-failure alarm is the fourth. The worst month is now $1.60 above the $5 goal in the Scope section.

What would bring it back under $5, if that matters more than the observability: the monitor's three occasional skip metrics are nine of the eleven billed ones. Without `deadlineSkips`, `busySkips` and `laggingNodeSkips` the worst month publishes 12 metrics, 2 of them billed, and the total is about $3.90. Dropping `deliveriesDead` and `deliveryBatchFailures` as well leaves 10 published metrics, all free, and a total of about $3.30; the dead-letter alarm still pages on a dead delivery, and both functions log every one. Neither cut touches an alarm or any behaviour.

This table is the demo instance only. The two example stacks under `infra/terraform/examples` sit entirely inside the free tier: `monitor-actions-only`, with `outbound_queue = true`, creates 8 alarms; `relayer-only` creates 7 alarms and publishes 1 custom metric (`pendingAgeSeconds` — its one signer has no `balance_alarm_gwei` set, so `signerBalanceGwei` is never emitted there). Both alarm counts, and the one metric, are under the free ten.

## Milestones

Each milestone gets its own implementation plan.

1. **Monitor.** `packages/core`, durable and fast scans with a per-chain lease, DynamoDB table, Terraform for the monitor, CI with lint, unit and Anvil integration tests.
2. **Relayer.** `packages/kms-signer`, relayer API routes, signer, sweeper, `modules/relayer`, `packages/relayer-client`, including the subscriptions and gas-sponsorship projects' relayer requirements: receipt outcome, revert data, caller reference, calldata policy, transaction dependencies, module inputs and outputs, and a public test signer.
3. **Actions.** Dispatcher and reaper, webhook, SES, Telegram, relayer, SQS and Lambda senders, the delivery store with its retry and dead-letter handling, the two-stage SSRF guard, the outbound delivery queue, `modules/actions`, and the `delivery:list` and `delivery:redrive` scripts.
4. **API and dashboard.** SIWE auth, rules, matches, deliveries and relayer views, CloudFront routing.
5. **Contracts, staging and demo.** Foundry contracts and tests, nightly end-to-end workflow, public demo deploy, README and operator docs.

Milestones 1, 2 and 3 are done.

**Deferred from milestone 1:** the GitHub OIDC deploy role, `terraform plan` posted as a PR comment, and per-rule match metrics.

**Deferred from milestone 3:** `GET /deliveries` and `POST /deliveries/{deliveryId}/redrive`, which are milestone 4 along with the dashboard's delivery view; Base Sepolia in the monitor, which is milestone 5 with the demo contracts; and a contract-state rule type, which is Project C item 7 and is not scheduled.

## Prerequisites

The user provides:
- an AWS account, with an IAM role for GitHub OIDC created during milestone 1,
- RPC URLs for the five chains (free tiers from Alchemy, Infura or similar),
- a verified SES sender address. `ses_from_address` creates the identity, but only the owner of the address can confirm it, and the sender's IAM policy allows `ses:SendEmail` only with that address as the from address. A new AWS account's SES is in the sandbox, where every **recipient** has to be verified as well and sending is capped; leaving the sandbox is a support request the operator makes,
- a Telegram bot token (milestone 3, optional),
- testnet ETH for the signer on Base Sepolia and Arbitrum Sepolia.
- the npm organisation `@blockwarden`. Its availability is unconfirmed because npm's site refused the automated check; if it is taken, the packages publish unscoped as `blockwarden-kms-signer` and `blockwarden-relayer-client`.

Local tooling to install: AWS CLI v2, Terraform, Node.js 24, pnpm. Anvil, DynamoDB Local, tflint, checkov and gitleaks run from Docker images. Docker is already installed.

## Conventions

- Comments are sparse and explain why, not what.
- Commit messages are plain and describe the change. No co-author trailers.
- Public interfaces listed under "Downstream consumers" change only with a semver bump and a changelog entry.
