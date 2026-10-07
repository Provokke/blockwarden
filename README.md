# Blockwarden

Self-hosted, serverless monitoring and transaction relaying for EVM chains, deployed into your own AWS account with Terraform.

OpenZeppelin shut down Defender on 1 July 2026. Blockwarden covers the same ground as its Monitor, Relayer and Actions, but runs as scale-to-zero Lambda functions, keeps signing keys in your own KMS, and costs a few dollars a month when idle.

## Status

Milestones 1, 2 and 3 of 5 are done.

- **Monitor.** It polls Ethereum, Base and Arbitrum once a minute and matches events against rules stored in DynamoDB. Durable records come from finalized blocks, and fast provisional alerts come from the chain head.
- **Relayer.** It signs and sends transactions on Base Sepolia and Arbitrum Sepolia with keys that never leave AWS KMS, behind an API-key HTTP API. Two packages come with it: [`@blockwarden/kms-signer`](packages/kms-signer) and [`@blockwarden/relayer-client`](packages/relayer-client).
- **Actions.** A match, or a relayed transaction changing status, becomes a delivery: a webhook, an email, a Telegram message, a relayed transaction, or a message into an SQS queue or a Lambda function. Deliveries retry, dead-letter and redrive.

The dashboard and the contracts come next. The design lives in [docs/design](docs/design/2026-09-15-blockwarden-design.md).

## How the monitor handles reorgs

It doesn't try to keep unfinalized records correct through reorgs. Each run does two scans.

- **Durable scan.** Reads logs only up to the chain's `finalized` block. Those blocks cannot reorg, so every record it writes is final. Each log request is batched with a head check, so a lagging RPC node that answers past its head with fewer logs instead of an error cannot advance the cursor. The head check cannot catch a load-balanced RPC URL that splits one batch across backends, or a node that is at the head but still missing log data, so point it at single-node or sticky endpoints.
- **Fast scan.** Reads the unfinalized tail up to the head, for rules in `fast` mode, and writes provisional records. The durable scan later marks each one `final` when its log is finalized, or `dropped` once it has passed the block by 64 blocks without seeing it.

A record is keyed by chain, transaction hash, the log's position among that transaction's matching logs, and rule. That way a provisional alert and its final record stay one item, even if a shallow reorg moves the transaction to another block.

Final records trail the head by the chain's finality: about 19 minutes on Base and Arbitrum, and about 13 minutes on Ethereum. If your RPC's `finalized` block goes more than an hour stale, an alarm fires.

## How the relayer keeps transactions moving

- **One signer, one queue group.** Requests go to an SQS FIFO queue grouped by signer, so a signer's transactions get nonces in the order they arrived. The nonce is taken and written onto the transaction in one DynamoDB transaction, so a crash can never lose one.
- **Policy before a nonce.** Each signer has an allowlist of contracts, optional function selectors per contract, optional fixed recipients for ERC-20 transfers (an entry with recipients may allow only `transfer`), a gas limit, a fee cap and a daily spend cap. A request the policy refuses, or whose gas estimate reverts, is answered with 422 and never reaches the queue. A 503 (`busy` or `rpc_unavailable`) is safe to send again with the same idempotency key.
- **KMS signatures.** KMS signs the transaction digest and returns DER. The signer normalises `s` to the low half of the curve (EIP-2) and finds `v` by recovering the signer's address.
- **A sweeper every minute.** It marks transactions mined and then confirmed, replaces a stuck one at the same nonce with fees geth accepts as a replacement, rebroadcasts what a node forgot or a reorg removed, resumes a signer paused for lack of funds, and requeues anything that waited too long. A transaction the node refuses outright is failed and a 0-value transfer takes its nonce, so later transactions are not blocked, unless a node took one of its signatures earlier: that one may still be mined, so the sweeper waits for a receipt, for the nonce to be used, or signs again.

KMS emulators do not sign digests correctly (moto hashes them again), so tests sign with an in-memory key behind the same interface. One test signs with a real KMS key when `BLOCKWARDEN_KMS_TEST_KEY_ID` is set.

## Actions

A rule's `actions` are what happens when it matches. A transaction's `tx.*` events go to every URL in its signer's `webhooks`. Both become **deliveries**: an item in the table with its own attempts, its own next attempt time and its own dead-letter state.

| Type | What it does |
|---|---|
| `webhook` | `POST`s the event to an https URL, signed with HMAC-SHA256. See [docs/webhooks/v1.md](docs/webhooks/v1.md). |
| `email` | Sends a rendering of the event through SES v2 from the module's verified address. |
| `telegram` | Sends the same rendering to a chat id through a bot token in SSM. |
| `relay` | Submits a fixed transaction through the relayer API, keyed on the delivery id so a retry never sends twice. |
| `sqs`, `lambda` | Delivers into a queue or a function named in an ARN allowlist Terraform sets. The ARN can name any 12-digit account id; nothing restricts a target to the deployment's own account. |

**Delivery, retries and dead letters.** Eight attempts. The step before attempt *n* is 10 seconds tripled each time, capped at 900, which is the longest delay SQS accepts. Each wait is jittered: the band is 40% of the step wide and its top is the lower of the step plus 20% and 900 s, so it hangs below the cap instead of being clipped onto it and a herd that failed together does not come back together. That gives about 10 s, 30 s, 90 s and 270 s, and from the fifth attempt 9 to 15 minutes. A delivery that never succeeds is dead about 43 minutes after it was made — 33 to 53 minutes across the jitter band. A `4xx` other than `429`, and a redirect, are permanent and dead-letter at once. A dead delivery is both `status: dead` on its item and a message on the dead-letter queue, which is what the alarm watches.

```bash
# what is dead
pnpm --filter @blockwarden/actions run delivery:list --table blockwarden-demo
# send one again
pnpm --filter @blockwarden/actions run delivery:redrive --table blockwarden-demo \
  --queue <delivery queue url> --dlq <dead-letter queue url> --id dlv_...
# or all of them
pnpm --filter @blockwarden/actions run delivery:redrive --table blockwarden-demo \
  --queue <delivery queue url> --dlq <dead-letter queue url> --all
```

`TABLE_NAME`, `DELIVERY_QUEUE_URL` and `DELIVERY_DLQ_URL` stand in for the three flags. The redrive resets the item, queues it again, and deletes the dead-letter copies of the deliveries it redrove, which is what clears the alarm. Run without `--dlq` and the copies stay until the queue's retention expires them, so the alarm stays in ALARM; that is the safe default for an operator who has not read the queue yet.

**Delivery is at least once.** Dedupe on `id` in the body `verifyWebhook()` returned: it is inside the signed bytes. The same value also rides along in the `X-Blockwarden-Delivery` header, but that header is not signed and is for tracing only. Two different events never share an id, and a transaction reorged out and mined again sends a second `tx.mined` with a different id.

**Where the guard runs.** A webhook URL is first checked when the rule is compiled, not when it is created: Terraform writes a rule's actions with no shape validation, and there is no rule-create route to check it at write time until milestone 4. Compiling checks https only, no credentials, no port 0, no literal address in a private, loopback, carrier-grade NAT, link-local, metadata, documentation, benchmarking, multicast, unique-local or translated range. It is checked again when the delivery is sent, this time by resolving the host. Every resolved address must pass, and the connection is then pinned to the address that passed, so a name that answers differently a moment later cannot move it. Redirects are never followed.

**Secrets.** Webhook secrets, the Telegram bot token and the relayer API key are SSM SecureString parameters, read through a five-minute cache. A webhook secret parameter may hold several comma-separated secrets: the sender signs with all of them and sends one `v1=` per secret, so a rotation overlaps. To rotate: add the new secret to the parameter, wait for receivers to accept it, then remove the old one. SES needs no credential — the sender's role carries `ses:SendEmail` with a condition on the from address.

A webhook action's own `secretParameter` is optional, and so is the deployment-wide `WEBHOOK_SECRET_PARAMETER` that it falls back to. An action that names neither cannot be signed: the delivery is refused on its first attempt with nothing sent, marked dead and copied to the dead-letter queue. See "Known limitations" in the design document for why neither setting can be made mandatory on its own.

**SES sandbox.** A new AWS account's SES is in the sandbox, where **every recipient** has to be verified too, and sending is capped. `ses_from_address` creates and must confirm the sender identity; moving out of the sandbox is a support request the operator makes.

**Rules without the dashboard.** `modules/blockwarden` takes a `rules` map and writes each one at apply time. A rule's `conditions` and each of its `actions` are JSON strings, because Terraform cannot type a rule's nested shape; the module validates what it can, and the monitor logs and drops the part of a rule that does not compile - an action that fails its schema is dropped and the rule goes on matching, while a rule whose event signature will not parse leaves the poll altogether.

**Deliveries that did not come from a match.** With `outbound_queue = true`, the module creates a queue that turns a message into a signed delivery with the caller's own header names:

```json
{
  "requestId": "merchant-42:invoice-1001:paid",
  "url": "https://merchant.example.com/hooks",
  "secretParameter": "/billwarden/merchants/42/webhook-secret",
  "signatureHeader": "Billwarden-Signature",
  "eventId": "evt_01J8Z",
  "body": { "type": "invoice.paid", "data": { "invoiceId": "1001" } }
}
```

`requestId` is the idempotency key: the same id is delivered once. `secretParameter` is required here, unlike on a rule's webhook action, and must sit under one of `outbound_secret_prefixes` — a prefix names what an outbound caller may point `secretParameter` at, not the full extent of what the sender's IAM policy can read: the same policy also grants the deployment-wide webhook secret, the Telegram token, the relayer API key and every signer's own webhook secret parameter.

## Local development

Requires Node.js 24, pnpm 12 and Docker.

```bash
pnpm install
pnpm run test               # unit and property tests
pnpm run test:integration   # Anvil, DynamoDB Local and moto in Docker
pnpm run typecheck
node scripts/pack-check.mjs # builds and packs the two published packages and imports them from the tarballs
node scripts/tf-check.mjs   # terraform fmt, validate, tflint, checkov

# the real-KMS test, with AWS credentials and an ECC_SECG_P256K1 SIGN_VERIFY key
BLOCKWARDEN_KMS_TEST_KEY_ID=<key id> AWS_REGION=<region> pnpm --filter @blockwarden/kms-signer run test
```

`tf-check.mjs` installs tflint plugins from GitHub. Set `GITHUB_TOKEN` (for example `GITHUB_TOKEN="$(gh auth token)"`) so the download is not rate limited.

## Deploying the monitor

Requires Terraform, the AWS CLI v2, and AWS credentials for the target account. The rule script uses the same credentials, so set `AWS_REGION` and, if you use one, `AWS_PROFILE` before running it.

1. Put each chain's RPC URLs in SSM. Separate several URLs with commas and they are tried in order.

   ```bash
   aws ssm put-parameter --name /blockwarden-demo/rpc/base --type SecureString --value "https://first,https://second"
   ```

   Leave out `--key-id`. The monitor can only decrypt parameters encrypted with the default `aws/ssm` key.

2. Build the Lambda bundle: `pnpm --filter @blockwarden/monitor run build`
3. Initialise Terraform: `cd infra/terraform/envs/demo && terraform init`
4. Decide whether to backfill. Skip this step to start at the current finalized block.

   Rules are not retroactive. The durable scan gives a rule final records only for blocks after the chain's durable cursor at the time the rule is added. The fast scan also gives a `fast` rule provisional records for blocks after the fast cursor, less its 20-block overlap. The first run creates the cursors at `start_block` when one is set, or at the current finalized block and the head otherwise. If no rule exists yet, that run moves the durable cursor straight to the finalized block.

   So to backfill, set `start_block` for that chain in the `chains` map in `infra/terraform/envs/demo/main.tf` (scanning starts after it), and add the rules before the first scheduled run. The schedules start polling as soon as `terraform apply` creates them, and the stack has no setting to hold them back. So create the table on its own first and add the rules, then continue with the full apply in step 5:

   ```bash
   # in infra/terraform/envs/demo
   terraform apply -var alarm_email=you@example.com -target=module.blockwarden.aws_dynamodb_table.main
   pnpm --filter @blockwarden/monitor run rule:put ../../examples/base-usdc-large-transfers.json --table blockwarden-demo
   ```

5. Apply the stack with an address for alarm emails, still in `infra/terraform/envs/demo`: `terraform apply -var alarm_email=you@example.com`
6. Confirm the subscription from the email SNS sends you. Alarms are not delivered until you do.
7. Check delivery once by forcing one alarm into the alarm state. It returns to its real state at the next evaluation.

   ```bash
   aws cloudwatch set-alarm-state --alarm-name blockwarden-demo-monitor-base-errors --state-value ALARM --state-reason test
   ```

8. Add rules, if you did not add them in step 4. A rule path is relative to `services/monitor`, and `pnpm --filter` works from anywhere in the repository.

   ```bash
   pnpm --filter @blockwarden/monitor run rule:put ../../examples/base-usdc-large-transfers.json --table blockwarden-demo
   ```

Free RPC tiers often cap `eth_getLogs` at a small block range. The poller halves a refused range until it fits, but setting `max_range` for that chain in `infra/terraform/envs/demo/main.tf` avoids the wasted calls.

## Deploying the actions pipeline

The demo stack deploys the dispatcher and the sender alongside the monitor, through the `actions` input of
`infra/terraform/modules/blockwarden`. To deploy the monitor and actions without the relayer, use
`infra/terraform/examples/monitor-actions-only`.

1. Put the default webhook signing secret in SSM before the apply. Without it every delivery burns its eight
   attempts, dies, and latches the dead-letters alarm.

   ```bash
   aws ssm put-parameter --name /blockwarden-demo/webhook-secret --type SecureString --value "$(openssl rand -hex 32)"
   # the monitor-actions-only example names its own path instead
   aws ssm put-parameter --name /bw-example/webhook-secret --type SecureString --value "$(openssl rand -hex 32)"
   ```

   Leave out `--key-id` here too. The sender may only decrypt with the default `aws/ssm` key. Several
   comma-separated secrets in one parameter are allowed while one is rotating: the sender signs with each of
   them, and a receiver that checks any one of them keeps working through the rotation.

2. A webhook action that names its own `secretParameter`, and a relayer signer that sets
   `webhook_secret_parameter`, read a different parameter. The sender can only read what the module granted it,
   so list a signer's parameter in `actions.signer_webhook_secret_parameters`, and put a rule's own parameter
   under one of `actions.rule_secret_prefixes`. The dispatcher refuses to build a delivery for an action naming
   a parameter outside that list, because the sender would otherwise sign a body of the rule's choosing with
   somebody else's secret. `actions.outbound_secret_prefixes` is the separate list for outbound requests, so
   granting one does not widen the other. A prefix is a parameter name with an optional trailing slash; `"/"`
   is not a prefix and is refused, because it would grant every parameter in the account.
3. Build the bundle: `pnpm --filter @blockwarden/actions run build`
4. Apply as for the monitor. Deliveries that used every attempt are copied to the `-deliveries-dlq` queue, which
   is what the `actions-dead-letters` alarm watches. Redrive them, and clear the copies that hold the alarm on,
   with:

   ```bash
   pnpm --filter @blockwarden/actions run delivery:redrive --table blockwarden-demo      --queue "$(terraform output -raw delivery_queue_url)" --dlq "$(terraform output -raw delivery_dead_letter_queue_url)" --all
   ```

   Without `--dlq` the deliveries are sent again but the alarm stays in ALARM until the copies expire.

5. The `-stream-failures` queue is a different thing and nothing redrives it: it holds DynamoDB stream batches
   Lambda gave up on, whose matches never became deliveries at all. Read those records back out of the stream
   within its 24 hours, then delete the messages.

Do not set `relayer_api_pair` on `modules/actions`. It carries nothing; it exists only to host the validation
that refuses `relayer_api_url` without `relayer_api_key_parameter`, which a module cannot express otherwise.

## Deploying the relayer

The demo stack in `infra/terraform/envs/demo` deploys the relayer next to the monitor and shares its table. To deploy the relayer on its own, use `infra/terraform/modules/relayer` as `infra/terraform/examples/relayer-only` does.

1. Put each testnet's RPC URLs in SSM, as for the monitor. The relayer takes at most 3 URLs per chain and refuses to start with more:

   ```bash
   aws ssm put-parameter --name /blockwarden-demo/rpc/base-sepolia --type SecureString --value "https://first,https://second"
   aws ssm put-parameter --name /blockwarden-demo/rpc/arbitrum-sepolia --type SecureString --value "https://first"
   ```

2. Set the signer's policy in the `signers` map: the contracts it may call, the fee cap and the daily spend cap. The demo signer allows only a burn address until the demo contracts exist.
3. Build the bundles: `pnpm --filter @blockwarden/relayer run build`
4. Apply, in `infra/terraform/envs/demo`: `terraform apply -var alarm_email=you@example.com`. Each signer gets a new KMS key, which costs $1 a month.
5. Create an API key for the signer. It is printed once, and only its SHA-256 is stored.

   ```bash
   pnpm --filter @blockwarden/relayer run apikey:create --table blockwarden-demo --signer demo --label ops
   ```

   A module can create keys instead, through its `api_keys` input. Those keys land in SSM and in Terraform state.

6. Find the signer's address and fund it with testnet ETH on each chain. Terraform cannot derive an address from a KMS public key, so the API reports it:

   ```bash
   curl -H "Authorization: Bearer <api key>" "$(terraform output -raw relayer_api_url | sed 's,/$,,')/v1/relayer/signers"
   ```

7. Relay from code with the client:

   ```ts
   import { getTx, relay } from '@blockwarden/relayer-client'

   const options = { baseUrl: process.env.RELAYER_URL!, apiKey: process.env.RELAYER_API_KEY! }
   const tx = await relay(options, { signerId: 'demo', chainId: 84532, to, data, idempotencyKey: 'charge-42' })
   console.log((await getTx(options, tx.txId)).status)
   ```

A fee cap too low to replace a stuck transaction, or a signer paused for lack of funds, keeps a transaction pending; the `pending-age` alarm fires after 30 minutes. If the sweeper is not invoked for 10 minutes, the `sweeper-not-running` alarm fires.

## Running cost

The demo stack is scale-to-zero except for CloudWatch and one KMS key, so almost all of the bill is alarms and custom metrics. After milestone 3 the stack creates **23 alarms** — 9 for the monitor on 3 chains, 10 for the relayer on 2 chains with 1 signer, and 4 for actions (dead letters, stream failures, and an `Errors` alarm for each of the dispatcher and the sender) — and publishes **up to 21 custom metrics**. CloudWatch's free tier is 10 alarm metrics and 10 custom metrics a month; every alarm in this stack watches exactly one standard-resolution metric, so that is 10 alarms free in practice here, and $0.10 and $0.30 a month for the rest.

| | Quiet month | Worst month |
|---|---|---|
| KMS, 1 signer key | $1.00 | $1.00 |
| DynamoDB on-demand | cents | under $1.00 |
| CloudWatch alarms (13 billed) | $1.30 | $1.30 |
| CloudWatch custom metrics (0 to 11 billed) | $0.00 | $3.30 |
| **Total** | **about $2.40** | **about $6.60** |

Milestone 3 added $0.40 of that as a fixed cost — four alarms, all of them past the free ten — and up to $0.60 more in a month where deliveries die or a stream batch fails, so up to $1.00 in all. `outbound_queue = true` adds a fifth alarm and $0.10. The worst month is above the design's $5 goal, and it needs every occasional metric to appear in the same month.

What would bring the worst month back under $5, if the operator wants that: the monitor's three occasional skip metrics are nine of the eleven billed ones (`deadlineSkips`, `busySkips` and `laggingNodeSkips`, one of each per chain). Without them the worst month publishes 12 metrics, 2 of them billed, and the total is about **$3.90**. Dropping the two actions metrics as well leaves 10 published metrics, all inside the free tier, and a total of about **$3.30** — the dead-letter alarm already pages on a dead delivery, and both functions log every one. Both are cuts to observability, not to behaviour, and neither touches an alarm.

This table is the demo instance only. The two example stacks under `infra/terraform/examples` are smaller and sit entirely inside the free tier: `monitor-actions-only`, with the outbound queue on, creates 8 alarms and no billed alarm or metric; `relayer-only` creates 7 alarms and publishes 1 custom metric, also unbilled.

## License

MIT
