# Blockwarden

Self-hosted monitoring and transaction relaying for EVM chains. It runs as Lambda functions in your own AWS account, set up with Terraform, and keeps signing keys in your own KMS.

It's a replacement for the Monitor, Relayer and Actions parts of OpenZeppelin Defender, which shut down on 1 July 2026. Nothing has been deployed yet. The code is built and tested offline.

## What's in here

- `services/monitor` polls Ethereum, Base and Arbitrum and matches events against rules stored in DynamoDB.
- `services/relayer` signs and sends transactions with KMS keys, behind an API-key HTTP API.
- `services/actions` turns matches and transaction updates into webhooks, emails, Telegram messages, relayed transactions or SQS/Lambda deliveries, with retries and a dead-letter queue.
- `services/api` and `apps/dashboard` are the session-authenticated API and a static dashboard over it.
- `contracts` holds the demo contracts (Foundry).
- `infra/terraform` has the module, the stacks and the bootstrap.
- `packages/kms-signer` and `packages/relayer-client` are the two published packages.

## Run it

You need Node.js 24, pnpm 12 and Docker.

```bash
pnpm install
pnpm run test               # unit and property tests, plus the contract tests
pnpm run test:integration   # Anvil, DynamoDB Local and moto in Docker
pnpm run typecheck
pnpm run demo:local         # local demo, no AWS involved
```

`demo:local` starts Anvil, DynamoDB Local and moto in Docker, deploys the demo contracts, stores a rule, fires an event, runs one monitor cycle and prints the signed webhook that arrives at a local catcher.

To work on the dashboard, run `pnpm --filter @blockwarden/dashboard run dev` and `pnpm --filter @blockwarden/dashboard run dev:proxy`, then open http://localhost:3100. The proxy needs something answering `/v1` on port 3200, which this repo doesn't provide.

## Deploying

Run `terraform apply` in `infra/terraform/bootstrap` with admin credentials. It creates the state bucket, the GitHub OIDC provider and the roles the workflows assume. Then run the `gh variable set` commands that `terraform output -raw github_variables` prints.

Set the stacks' own inputs by hand as repository variables:

```bash
gh variable set BLOCKWARDEN_ALLOWED_WALLETS --body '["0x..."]'   # who may sign in
gh variable set BLOCKWARDEN_ALARM_EMAIL --body you@example.com   # optional
```

Every workflow job that touches AWS does nothing until its role variable is set, so the pipeline stays green and idle until you wire up an account. `envs/staging` is applied on merges to `main`, and `envs/demo` only by a manual run.

## Licence

MIT
