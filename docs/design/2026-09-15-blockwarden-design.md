# Blockwarden design

Date: 2026-09-15
Status: approved for planning

Blockwarden is a self-hosted, serverless replacement for OpenZeppelin Defender's Monitor, Relayer and Actions, built for AWS. A team runs `terraform apply` in their own AWS account and gets:

- on-chain event monitoring that survives reorgs,
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

TypeScript throughout, using viem for chain access. Lambdas run on the Node.js 22 runtime on arm64, bundled with esbuild. Infrastructure is Terraform. Contracts are Foundry. CI/CD is GitHub Actions deploying to AWS through OIDC, with no long-lived AWS keys.

### Repository layout

```
blockwarden/
  packages/
    core/             pure logic: condition evaluator, reorg walk-back, fee bump math, shared types
    kms-signer/       viem LocalAccount backed by AWS KMS (secp256k1)
    relayer-client/   typed client for the relayer API, used by downstream projects
  services/
    monitor/          poller Lambda, confirmation promoter
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

**Monitor.** EventBridge Scheduler invokes one poller per chain every minute. The poller reads the chain cursor, checks for a reorg, fetches logs for all active rules on that chain, evaluates conditions and writes matches. An optional fast mode keeps the poller looping every 5 seconds for 55 seconds of each invocation, for about $3/month per chain.

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
| Chain cursor | `CHAIN#<chainId>` | `CURSOR` | `block`, `hashes` (last 256 block hashes), `version` |
| Rule | `RULE#<ruleId>` | `META` | GSI1: `CHAIN#<chainId>#RULES` / `RULE#<ruleId>`, set only while active |
| Match | `MATCH#<matchId>` | `META` | status `pending`, `confirmed` or `retracted`; TTL 30 days; GSI1: `RULE#<ruleId>` / `<blockNumber>#<logIndex>`; GSI2 while pending: `CHAIN#<chainId>#PENDING` / `<blockNumber>` |
| Delivery | `MATCH#<matchId>` | `DELIVERY#<actionId>#<event>` | attempts, last error, status |
| Signer | `SIGNER#<signerId>` | `META` | address, KMS key id, policy |
| Signer nonce | `SIGNER#<signerId>` | `NONCE#<chainId>` | atomic counter |
| Transaction | `TX#<txId>` | `META` | status, nonce, raw signed tx, hash, fee history; GSI2 while unsettled: `TXPENDING#<chainId>` / `<submittedAt>` |
| Idempotency | `IDEMP#<apiKeyHash>#<key>` | `META` | maps to `txId`, TTL 24 hours |
| API key | `APIKEY#<sha256>` | `META` | signer allowlist, policy overrides |
| SIWE nonce | `SIWE#<nonce>` | `META` | TTL 5 minutes |

`matchId` is `keccak256(chainId, blockHash, logIndex, ruleId)`. Matches are written with `attribute_not_exists(PK)`, which makes replays and overlapping polls harmless.

GSI2 is sparse: an item only appears in it while it has work outstanding, so the promoter and the sweeper never scan.

## Rules

```json
{
  "chainId": 8453,
  "addresses": ["0x..."],
  "event": "event Transfer(address indexed from, address indexed to, uint256 value)",
  "conditions": { "all": [ { "field": "args.value", "op": "gte", "value": "1000000000000000000" } ] },
  "confirmation": { "mode": "confirmed", "blocks": 12 },
  "actions": [ { "type": "webhook", "url": "https://example.com/hook" } ]
}
```

- `conditions` supports `all` and `any` groups, nestable, with ops `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in` and `contains`. Numeric comparisons parse both sides as bigint.
- `confirmation.mode` is `fast` (dispatch on `pending`, send a retraction on reorg), `confirmed` with a block count, or `finalized` (the chain's `finalized` block tag).
- Rules are validated on create and update: the event signature must parse, every condition field must exist in the event's ABI, and every action must pass its channel's schema. Invalid rules are rejected with a field-level error.

## Data flow

### Poll cycle (per chain)

1. Load the cursor. Fetch the head with `eth_blockNumber`.
2. Fetch the header of `cursor.block + 1` and compare its `parentHash` with the stored hash for `cursor.block`.
3. On mismatch, walk back through `hashes`, fetching canonical headers, until a stored hash matches the canonical chain. Mark matches in orphaned blocks `retracted`, then set the cursor to the common ancestor. A reorg deeper than 256 blocks halts that chain's poller and raises an alarm. It does not guess.
4. Fetch logs from `cursor.block + 1` to `min(head, cursor.block + maxRange)`, filtered by the union of addresses and topics across active rules. When the RPC rejects a range, halve it and retry, down to a single block.
5. Decode each log against the ABI of every matching rule and evaluate conditions.
6. Write matches with the conditional put described above.
7. Update the cursor with the new block and hashes, conditioned on `version`. If another invocation advanced it first, stop without error.
8. Repeat from step 2 until head is reached or 50 seconds have elapsed.

### Confirmation promoter

It runs at the end of each poll cycle. It queries GSI2 `CHAIN#<chainId>#PENDING` for matches at or below `head - blocks`, or at or below the `finalized` block for rules in that mode. It re-checks each block hash against the canonical chain, then sets the match to `confirmed` or `retracted`.

### Dispatch

The dispatcher reads stream records and enqueues a delivery when:

- a match is inserted as `pending` and its rule is in `fast` mode,
- a match moves to `confirmed` and its rule is in `confirmed` or `finalized` mode,
- a match moves to `retracted` and its rule is in `fast` mode (a retraction notice).

Each delivery is keyed by `matchId`, `actionId` and event, and written with a conditional put, so stream redelivery does not cause duplicate sends.

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
   - A receipt is found: set `mined`, then `confirmed` after the chain's confirmation count. Drop out of GSI2.
   - No receipt after the chain's stuck threshold: re-sign the same nonce with fees raised by the greater of 12.5% and the current estimate, capped at the policy's maximum fee, and resend.
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
- A failed cycle leaves the cursor untouched; the next invocation resumes.
- An alarm fires when cursor lag passes a per-chain threshold (default: 50 blocks on Ethereum, 300 on Base and Arbitrum).

**Rules**
- A rule that fails to decode at runtime is set to `errored` with the reason, and polling continues for every other rule.

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
  - reorg walk-back: for any randomly generated fork, the final match set equals the canonical chain's match set,
  - condition evaluation against bigint edge cases,
  - fee bump math: every replacement satisfies the node's minimum bump,
  - DER parsing and `v` recovery, against signatures from a local secp256k1 key.

**Contracts (Foundry)**
- Unit, fuzz and invariant tests.
- Invariants include: a forwarder request cannot be replayed, and `TopUpVault` balances never exceed deposits.

**Integration (Docker: Anvil + LocalStack)**
- `anvil_reorg <depth> <txs>` produces real reorgs; the test asserts `fast` rules emit retractions and `confirmed` rules never dispatch orphaned matches.
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
- **Metrics** (CloudWatch embedded metric format): cursor lag per chain, matches per rule, delivery failures, dead-letter depth, relayer pending age, signer native balance.
- **Alarms** go to SNS email: cursor lag, reorg halt, dead-letter depth above zero, signer balance below threshold, sweeper errors.

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
| **Total** | **about $2 to $4 per month** |

Fast mode adds about $3 per chain per month.

## Milestones

Each milestone gets its own implementation plan.

1. **Monitor.** `packages/core`, poller, promoter, DynamoDB table, Terraform for the monitor, CI with lint, unit and Anvil integration tests.
2. **Relayer.** LocalStack KMS probe, `packages/kms-signer`, relayer API routes, signer, sweeper, `modules/relayer`, `packages/relayer-client`.
3. **Actions.** Dispatcher, webhook, SES, Telegram and relayer senders, dead-letter handling, SSRF guard.
4. **API and dashboard.** SIWE auth, rules, matches, deliveries and relayer views, CloudFront routing.
5. **Contracts, staging and demo.** Foundry contracts and tests, nightly end-to-end workflow, public demo deploy, README and operator docs.

## Prerequisites

The user provides:
- an AWS account, with an IAM role for GitHub OIDC created during milestone 1,
- RPC URLs for the five chains (free tiers from Alchemy, Infura or similar),
- a verified SES sender address,
- a Telegram bot token (milestone 3, optional),
- testnet ETH for the signer on Base Sepolia and Arbitrum Sepolia.
- the npm organisation `@blockwarden`. Its availability is unconfirmed because npm's site refused the automated check; if it is taken, the packages publish unscoped as `blockwarden-kms-signer` and `blockwarden-relayer-client`.

Local tooling to install: AWS CLI v2, Terraform, Foundry, Node.js 22, pnpm. Docker is already installed.

## Conventions

- Comments are sparse and explain why, not what.
- Commit messages are plain and describe the change. No co-author trailers.
- Public interfaces listed under "Downstream consumers" change only with a semver bump and a changelog entry.
