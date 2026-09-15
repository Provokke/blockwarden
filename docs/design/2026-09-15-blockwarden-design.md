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
    core/             pure logic: rule engine, match keys, adaptive log fetching, fee bump math, shared types
    kms-signer/       viem LocalAccount backed by AWS KMS (secp256k1)
    relayer-client/   typed client for the relayer API, used by downstream projects
  services/
    monitor/          poller Lambda: finalized durable scan and fast provisional scan
    actions/          dispatcher and channel senders
    relayer/          signer Lambda, sweeper Lambda
    api/              HTTP API handlers and the SIWE authorizer
  apps/
    dashboard/        Next.js static export
  contracts/          Foundry project
  infra/terraform/
    modules/blockwarden/   full stack
    modules/relayer/       relayer only, for downstream projects
    envs/demo/
    envs/staging/
  docs/design/
```

pnpm workspaces. `packages/core` has no AWS or network dependencies so it can be unit and property tested in isolation.

### Components

**Monitor.** EventBridge Scheduler invokes one poller per chain every minute, and a DynamoDB lease keeps a single poller active per chain. Each run does two scans. The durable scan reads logs from its cursor up to the chain's `finalized` block, so every match it writes is final and never needs retracting. The fast scan reads the unfinalized tail up to the head for rules in `fast` mode and writes provisional matches, which the durable scan later marks `final` or `dropped`. Final records trail the head by the chain's finality. Measured on 2026-09-15 through the official RPCs, that was about 19 minutes on Base and on Arbitrum. On Ethereum it is about 13 minutes by protocol design.

**Relayer.** `POST /v1/relayer/txs` validates the request against the signer's policy and enqueues it on an SQS FIFO queue with the signer id as the message group. The signer Lambda consumes the queue, so transactions for one signer are processed strictly in order. A sweeper Lambda runs every minute to track receipts, replace stuck transactions and fill nonce gaps.

**Actions.** A dispatcher Lambda reads the DynamoDB stream for match status changes and enqueues deliveries on SQS with a dead-letter queue. Channel senders handle webhook, SES email, Telegram and relayer calls.

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
| Delivery | `MATCH#<matchId>` | `DELIVERY#<actionId>#<event>` | attempts, last error, status |
| Signer | `SIGNER#<signerId>` | `META` | address, KMS key id, policy, `webhooks` (URLs subscribed to this signer's `tx.*` events) |
| Signer nonce | `SIGNER#<signerId>` | `NONCE#<chainId>` | atomic counter |
| Transaction | `TX#<txId>` | `META` | status, nonce, raw signed tx, hash, fee history; GSI2 while unsettled: `TXPENDING#<chainId>` / `<submittedAt>` |
| Idempotency | `IDEMP#<apiKeyHash>#<key>` | `META` | maps to `txId`, TTL 24 hours |
| API key | `APIKEY#<sha256>` | `META` | signer allowlist, policy overrides |
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
- Rules are validated on create and update: the event signature must parse, every condition field must exist in the event's ABI, and every action must pass its channel's schema. Invalid rules are rejected with a field-level error.

## Data flow

### Poll cycle (per chain)

Each run takes the chain's lease, runs both scans inside a 50-second budget, and releases the lease. If another run holds the lease, it returns without touching the chain.

**Durable scan**

1. Read the chain's `finalized` block. A chain configured with `FINALITY_DEPTH` (for chains without the tag, typically 256) uses the head minus that depth instead. When `finalized` is unavailable and no depth is configured, the run skips the durable scan. It never guesses a depth, because a provider that normally supports the tag but errors once would otherwise send the durable scan into unfinalized blocks. The durable-lag alarm catches a persistent outage.
2. Fetch logs from `durableBlock + 1` to `min(finalized, durableBlock + maxRange)`, where `maxRange` defaults to 2,000 blocks, filtered by the union of addresses and topic0s across active rules.
   - **Halving.** When the RPC rejects a range, or answers with a body over 10 MB, halve it and retry, down to a single block. The next range starts at the size that last fitted. The size doubles again, up to `maxRange`, after a range that needed no halving.
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
3. Save `fastBlock` once, at the end of the last chunk read in full. It never moves behind its previous position, unless the head itself is below that position; then it follows the head down.

### Match keys

`matchKey` is `keccak256(chainId, transactionHash, ordinal, ruleId)`. `ordinal` is the log's position among the logs in the same transaction that match the same rule. A transaction's logs all sit in one block, so both scans compute the same key for the same event. The key leaves out the block, so a provisional record and its final record stay one item even when a shallow reorg re-includes the transaction in a different block.

Known limit: if a reorg changes which of a transaction's logs match (for example, it now emits a different number of them), the fast alert ends `dropped` and the final record arrives as a separate event.

### Dispatch

The dispatcher reads stream records and enqueues a delivery when:

- a match is created as `provisional` and its rule is in `fast` mode,
- a match becomes `final`, for rules in either mode (for a `fast` rule this confirms the earlier provisional alert),
- a match moves to `dropped` and its rule is in `fast` mode (a drop notice),
- a transaction item changes status, in which case it enqueues a `tx.<status>` delivery to each URL in the signer's `webhooks`.

Each delivery is keyed by `matchKey`, `actionId` and event, and written with a conditional put, so stream redelivery does not cause duplicate sends.

Webhooks are POSTed with `X-Blockwarden-Signature` (HMAC-SHA256 of timestamp and body) and `X-Blockwarden-Delivery` (the delivery id, for receiver-side idempotency).

### Relayer

1. `POST /v1/relayer/txs` takes `{ signerId, chainId, to, data, value?, gasLimit?, idempotencyKey }`.
2. The API checks the signer's policy (allowed `to` addresses, maximum gas, daily spend cap), then runs `eth_estimateGas`. A call that would revert is rejected here, before any nonce is reserved.
3. It writes the transaction as `queued`, writes the idempotency record, and sends it to SQS FIFO with group id `signerId` and deduplication id `idempotencyKey`. A repeated `idempotencyKey` returns the original `txId`.
4. The signer Lambda:
   - reserves the next nonce with an atomic update on `NONCE#<chainId>`, reconciling with `eth_getTransactionCount(address, "pending")` on cold start,
   - builds an EIP-1559 transaction from current fee estimates,
   - asks KMS to sign the digest with `ECDSA_SHA_256`,
   - parses the DER signature into `r` and `s`, normalises `s` to the lower half of the curve order (EIP-2), and finds `v` by recovering against the signer's known address,
   - stores the raw signed transaction, sends it with `eth_sendRawTransaction`, and sets status `submitted`.
5. The sweeper queries GSI2 `TXPENDING#<chainId>` every minute:
   - A receipt is found: set `mined`, then `confirmed` after the chain's confirmation count (default 5 blocks on Base Sepolia and Arbitrum Sepolia). Drop out of GSI2.
   - No receipt after the chain's stuck threshold (default 90 seconds since the last send): re-sign the same nonce with fees raised by the greater of 12.5% and the current estimate, capped at the policy's maximum fee, and resend.
   - A receipt disappears after a reorg: set back to `submitted` and rebroadcast the stored raw transaction.
   - A transaction fails permanently after its nonce was reserved: send a 0-value self-transfer at that nonce so later transactions are not blocked.

Status values: `queued`, `submitted`, `mined`, `confirmed`, `failed`, `cancelled`. Every status change emits a `tx.*` event through the actions pipeline, so relayer users can subscribe by webhook instead of polling.

## HTTP API

All routes are under `/v1`. Dashboard routes need a SIWE session. Relayer routes accept a session or an API key in `Authorization: Bearer <key>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/siwe/nonce` | issue a nonce |
| POST | `/auth/siwe/verify` | verify the message and signature, set the session cookie |
| POST | `/auth/logout` | clear the session |
| GET, POST | `/rules` | list, create |
| GET, PATCH, DELETE | `/rules/{ruleId}` | read, update, delete |
| GET | `/matches?ruleId=&cursor=` | match history |
| GET | `/deliveries?status=&cursor=` | delivery history |
| POST | `/deliveries/{deliveryId}/redrive` | resend from the dead-letter queue |
| GET | `/relayer/signers` | signers (defined in Terraform, read-only through the API) |
| POST | `/relayer/txs` | submit |
| GET | `/relayer/txs/{txId}` | status |
| GET | `/relayer/txs?status=&cursor=` | list |
| GET | `/health` | per-chain cursor lag, queue depth |

Sessions are HS256 JWTs in an `HttpOnly; Secure; SameSite=Strict` cookie, 12-hour lifetime, signed with a secret from SSM Parameter Store. The dashboard's allowed wallets are an allowlist in Terraform variables.

## Downstream consumers

Two follow-up projects depend on this one, so these interfaces are treated as public and versioned with semver from the first release:

- **`@blockwarden/kms-signer`** exports `toKmsAccount({ keyId, region })`, returning a viem `LocalAccount` that implements `signTransaction`, `signMessage` and `signTypedData`. The gas-sponsorship project uses `signTypedData` for paymaster approvals.
- **`@blockwarden/relayer-client`** exports `relay()`, `getTx()` and `verifyWebhook()`. The subscriptions project uses it to call `charge()` each billing period.
- **`modules/relayer`** is a Terraform module that deploys only the relayer, signer keys and sweeper, so a downstream project does not have to deploy the monitor.

## Error handling

**RPC**
- Each chain has an ordered list of RPC URLs with failover.
- The durable log read sends `eth_blockNumber` and `eth_getLogs` as one batch to one node and fails over the pair together, so a head and its logs always come from the same node.
- A failed cycle never advances the cursor past blocks that were not fully read and written; the next invocation resumes.
- An alarm fires when the durable scan falls more than a per-chain threshold behind the finalized block (default: 50 blocks on Ethereum, 300 on Base and Arbitrum).
- An alarm fires when the RPC's `finalized` block is more than 60 minutes old. On 2026-09-15 one public provider reported `finalized` about 17.8 hours stale on Base and Arbitrum.

**Rules**
- A stored rule that no longer compiles is skipped and logged, and polling continues for every other rule.

**Actions**
- Exponential backoff with jitter, 8 attempts, then the dead-letter queue.
- A webhook response of 4xx other than 429 is not retried.
- Dead-lettered deliveries appear in the dashboard with a redrive button.

**Relayer**

| Condition | Handling |
|---|---|
| estimate reverts | reject with 422 before reserving a nonce |
| `nonce too low` | reconcile nonce from chain, check whether the tx was already mined, resend if not |
| `replacement transaction underpriced` | raise fees to the replacement minimum, resend |
| `insufficient funds` | pause the signer, alarm, leave queued transactions queued |
| KMS throttling | retry with jitter; FIFO ordering holds because the message is not deleted |
| RPC timeout after send | treat as possibly sent; the sweeper resolves it by hash |

## Security

- **KMS.** The key policy allows `kms:Sign` and `kms:GetPublicKey` only to the signer and sweeper Lambda roles. Keys are non-exportable. CloudTrail records every signature.
- **IAM.** One role per Lambda, scoped to the exact table, queues and keys it uses. Generated by Terraform, no wildcards on resources.
- **API keys.** Stored as SHA-256 hashes, each carrying its own signer allowlist and policy.
- **SIWE.**
  - The server checks domain, URI, nonce (single use, 5-minute TTL), chain id and expiry.
  - Smart contract wallets are verified through EIP-1271 using viem's `verifyMessage`.
- **Webhooks (SSRF).**
  - The destination hostname is resolved, and the request is refused if any resolved address is private, loopback, link-local (including `169.254.169.254`) or unique-local IPv6.
  - HTTPS only. Redirects are not followed.
- **Secrets.** RPC URLs, the JWT secret, webhook HMAC secrets and the Telegram bot token live in SSM Parameter Store as SecureString parameters.
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
  - DER parsing and `v` recovery, against signatures from a local secp256k1 key.

**Contracts (Foundry)**
- Unit, fuzz and invariant tests.
- Invariants include: a forwarder request cannot be replayed, and `TopUpVault` balances never exceed deposits.

**Integration (Docker: Anvil + DynamoDB Local; the SQS and KMS emulator is chosen in milestone 2 because the LocalStack repository is archived)**
- `anvil_reorg <depth> <txs>` produces real reorgs; the test asserts a `fast` rule's provisional match becomes `dropped` when its log is reorged away, and `final` when the log is finalized.
- `anvil_dropTransaction` simulates a stuck transaction; the test asserts the sweeper replaces it at the same nonce.
- DynamoDB streams, SQS FIFO ordering and dead-letter behaviour run against LocalStack.
- KMS signing: the first milestone starts with a probe that checks whether LocalStack signs with `ECC_SECG_P256K1` keys. If it does, integration tests use it. If it does not, integration tests use an in-process secp256k1 implementation of the same signer interface, and one test signs against a real KMS key in the staging account.

**Infrastructure**
- `terraform fmt -check`, `terraform validate`, tflint and checkov on every pull request.
- `terraform plan` output posted as a PR comment.

**End to end (nightly GitHub Actions)**
1. Deploy `envs/staging` through OIDC.
2. Create a rule on Base Sepolia watching `DemoEmitter`, emit an event, assert the webhook arrives with a valid signature.
3. Relay a `TopUpVault` top-up, assert it reaches `confirmed`.
4. Leave the stack running; it costs close to nothing idle.

## Observability

- **Logs.** Structured JSON logs through Powertools for AWS Lambda (TypeScript), with a correlation id carried from match to delivery and from API request to transaction.
- **Metrics** (CloudWatch embedded metric format): durable lag and finalized block age per chain, matches per rule, delivery failures, dead-letter depth, relayer pending age, signer native balance.
- **Alarms** go to SNS email: durable lag, finalized block older than 60 minutes, dead-letter depth above zero, signer balance below threshold, sweeper errors.

## Cost estimate (demo instance, idle)

These are estimates from published AWS pricing and have to be measured after the first deploy.

| Item | Estimate |
|---|---|
| Lambda: 3 pollers and 1 sweeper at 1/min, about 173k invocations/month | within the always-free 1M requests and 400k GB-seconds |
| EventBridge Scheduler | within free invocations |
| DynamoDB on-demand, small table | under $1 |
| SQS | within the 1M free requests |
| KMS: 2 keys, low sign volume | about $2 |
| API Gateway HTTP API | cents at demo traffic |
| CloudFront, S3 | within free tier at demo traffic |
| SSM standard parameters, 10 alarms | free |
| CloudWatch custom metrics: up to 5 per chain. `durableLag` and `finalizedAgeSeconds` are emitted on most runs. `deadlineSkips` is emitted whenever a run stops for time, which includes normal catch-up after a start block or an outage. `busySkips` and `laggingNodeSkips` are emitted only when they occur | the first 10 are free, then $0.30/metric/month |
| **Total** | **about $2 to $4 per month** |

The fast scan adds one `eth_getLogs` call per run on each chain that has `fast` rules.

## Milestones

Each milestone gets its own implementation plan.

1. **Monitor.** `packages/core`, durable and fast scans with a per-chain lease, DynamoDB table, Terraform for the monitor, CI with lint, unit and Anvil integration tests.
2. **Relayer.** LocalStack KMS probe, `packages/kms-signer`, relayer API routes, signer, sweeper, `modules/relayer`, `packages/relayer-client`.
3. **Actions.** Dispatcher, webhook, SES, Telegram and relayer senders, dead-letter handling, SSRF guard.
4. **API and dashboard.** SIWE auth, rules, matches, deliveries and relayer views, CloudFront routing.
5. **Contracts, staging and demo.** Foundry contracts and tests, nightly end-to-end workflow, public demo deploy, README and operator docs.

**Deferred from milestone 1:** the GitHub OIDC deploy role, `terraform plan` posted as a PR comment, and per-rule match metrics.

## Prerequisites

The user provides:
- an AWS account, with an IAM role for GitHub OIDC created during milestone 1,
- RPC URLs for the five chains (free tiers from Alchemy, Infura or similar),
- a verified SES sender address,
- a Telegram bot token (milestone 3, optional),
- testnet ETH for the signer on Base Sepolia and Arbitrum Sepolia.
- the npm organisation `@blockwarden`. Its availability is unconfirmed because npm's site refused the automated check; if it is taken, the packages publish unscoped as `blockwarden-kms-signer` and `blockwarden-relayer-client`.

Local tooling to install: AWS CLI v2, Terraform, Node.js 24, pnpm. Anvil, DynamoDB Local, tflint, checkov and gitleaks run from Docker images. Docker is already installed.

## Conventions

- Comments are sparse and explain why, not what.
- Commit messages are plain and describe the change. No co-author trailers.
- Public interfaces listed under "Downstream consumers" change only with a semver bump and a changelog entry.
