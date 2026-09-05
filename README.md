# Blockwarden

Self-hosted, serverless monitoring and transaction relaying for EVM chains, deployed into your own AWS account with Terraform.

OpenZeppelin shut down Defender on 1 July 2026. Blockwarden covers the same ground as its Monitor, Relayer and Actions, but runs as scale-to-zero Lambda functions, keeps signing keys in your own KMS, and costs a few dollars a month when idle.

## Status

Milestones 1 and 2 of 5 are done.

- **Monitor.** It polls Ethereum, Base and Arbitrum once a minute and matches events against rules stored in DynamoDB. Durable records come from finalized blocks, and fast provisional alerts come from the chain head.
- **Relayer.** It signs and sends transactions on Base Sepolia and Arbitrum Sepolia with keys that never leave AWS KMS, behind an API-key HTTP API. Two packages come with it: [`@blockwarden/kms-signer`](packages/kms-signer) and [`@blockwarden/relayer-client`](packages/relayer-client).

Actions, the dashboard and the contracts come next. The design lives in [docs/design](docs/design/2026-09-15-blockwarden-design.md).

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
- **A sweeper every minute.** It marks transactions mined and then confirmed, replaces a stuck one at the same nonce with fees geth accepts as a replacement, rebroadcasts what a node forgot or a reorg removed, resumes a signer paused for lack of funds, and requeues anything that waited too long. A transaction the node refuses outright is failed and a 0-value transfer takes its nonce, so later transactions are not blocked.

KMS emulators do not sign digests correctly (moto hashes them again), so tests sign with an in-memory key behind the same interface. One test signs with a real KMS key when `BLOCKWARDEN_KMS_TEST_KEY_ID` is set.

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

## Deploying the relayer

The demo stack in `infra/terraform/envs/demo` deploys the relayer next to the monitor and shares its table. To deploy the relayer on its own, use `infra/terraform/modules/relayer` as `infra/terraform/examples/relayer-only` does.

1. Put each testnet's RPC URLs in SSM, as for the monitor:

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

## License

MIT
