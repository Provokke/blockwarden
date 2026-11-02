# Blockwarden

Self-hosted monitoring and transaction relaying for EVM chains. It runs as Lambda functions in your own AWS account, set up with Terraform, and keeps signing keys in your own KMS.

It's a replacement for the Monitor, Relayer and Actions parts of OpenZeppelin Defender, which shut down on 1 July 2026. Nothing has been deployed yet. The code is built and tested offline.

## What's in here

- `services/monitor` polls Ethereum, Base and Arbitrum and matches events against rules stored in DynamoDB.
- `services/relayer` signs and sends transactions with KMS keys, behind an API-key HTTP API.
- `services/actions` turns matches and transaction updates into webhooks, emails, Telegram messages, relayed transactions or SQS/Lambda deliveries, with retries and a dead-letter queue.
- `services/api` and `apps/dashboard` are the session-authenticated API and a static dashboard over it.
- `contracts` holds the demo contracts (Foundry).
- `infra/terraform` has the module and the demo stack.
- `packages/kms-signer` and `packages/relayer-client` are the two published packages.

## Run it

You need Node.js 24, pnpm and Docker.

```bash
pnpm install
pnpm run test               # unit and property tests
pnpm run test:integration   # Anvil, DynamoDB Local and moto in Docker
pnpm run typecheck
```

To work on the dashboard, run `pnpm --filter @blockwarden/dashboard run dev`.

## Deploying

You need Terraform, the AWS CLI v2 and credentials for the target account. The demo stack also wires in the API, so build it first and set who may sign in:

```bash
pnpm --filter @blockwarden/api run build
```

```hcl
# infra/terraform/envs/demo/terraform.tfvars
allowed_wallets = ["0x..."]
```

Put each chain's RPC URLs in SSM (comma separated, tried in order, at most 3 per chain once the API is up), then run `terraform apply` in `infra/terraform/envs/demo`.

```bash
aws ssm put-parameter --name /blockwarden-demo/rpc/base --type SecureString --value "https://first,https://second"
```

Leave out `--key-id`. The monitor can only decrypt parameters encrypted with the default `aws/ssm` key.

## Licence

MIT
