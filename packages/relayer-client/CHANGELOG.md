# Changelog

## 0.2.0

First release. Nothing before this version was published to npm.

- `relay`, `getTx`, `listSigners` and `RelayerApiError` for the relayer API.
- `verifyWebhook`, `signWebhook`, `isTxEvent`, `isMatchEvent` and `parseTx` for webhooks, with
  `SIGNATURE_HEADER`, `DELIVERY_HEADER`, `DEFAULT_TOLERANCE_SECONDS` and `WEBHOOK_SPEC_VERSION`.
- `MatchEventData`, `MATCH_STATUSES` and `TX_STATUSES`, and `specVersion` in the webhook envelope.
- `toDecodedValue`, which puts a decoded event argument into the form the schema publishes: an integer viem
  decoded as a JS number becomes a decimal string, nested through arrays and tuples, and a number that is not
  an integer throws rather than being rounded.
- `isMatchEvent` checks the width of `matchKey`, `transactionHash`, `blockHash` and `address`; hex with no
  fixed width, such as calldata and revert data, is accepted at any length.
- `revertData: Hex | null` is a required property of `RelayerTx` and `RelayerTxBody`, and `isTxEvent` refuses
  a body that leaves it out.
- The payload schema is published at `docs/webhooks/v1.md`.
