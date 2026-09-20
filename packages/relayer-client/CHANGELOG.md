# Changelog

## 0.2.0

- Added `isMatchEvent`, `MatchEventData` and `MATCH_STATUSES` for `match.*` webhooks, and `WEBHOOK_SPEC_VERSION`.
- Added `specVersion` to the webhook envelope.
- **Source-breaking:** `revertData: Hex | null` is a required property of `RelayerTx` and `RelayerTxBody`.
  Reading a transaction is unchanged, but code that builds one of these types now has to set it, as this
  repository's own test fixtures had to. A body that arrives without the field still passes `isTxEvent`, and
  `parseTx`, `relay` and `getTx` all report it as `null`.
- Added `toDecodedValue`, which puts a decoded event argument into the form the schema publishes: an integer
  viem decoded as a JS number becomes a decimal string, nested through arrays and tuples, and a number that is
  not an integer throws rather than being rounded.
- `isMatchEvent` now checks the width of `matchKey`, `transactionHash`, `blockHash` and `address`; hex with no
  fixed width, such as calldata and revert data, is still accepted at any length.
- Published the payload schema at `docs/webhooks/v1.md`.

## 0.1.0

- First release: `relay`, `getTx`, `listSigners`, `verifyWebhook`, `signWebhook`, `isTxEvent`, `parseTx`.
