# Contract client event observer

`EscrowGateClient.watchEscrow(escrowId)` returns an
`AsyncIterableIterator<EscrowEvent>` for the escrow contract configured on the
client:

```ts
import { EscrowGateClient } from "@soroban-anchor-gate/contract-client";

const client = new EscrowGateClient({
  contractId: "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
});

for await (const event of client.watchEscrow(42n)) {
  console.log(event.type, event.escrowId, event.metadata.txHash);
  if (event.type === "disbursed") break;
}
```

Escrow IDs are positive `bigint` values in the contract's `u64` range. The
iterator starts after the latest closed ledger reported by RPC; it does not
replay earlier events. `EscrowEvent` is a discriminated union for `created`,
`disbursed`, `split_disb`, `refunded`, `keeper_refund`, `dispute_resolved`, and
`clawback_handled`. The contract indexes most escrow IDs in the second event
topic. `ClawbackHandled` instead includes the ID in its event data, so the
observer decodes that payload before filtering it.

## Polling and delivery

The iterator checks the latest ledger every four seconds by default and only
queries event ranges when a new ledger is available. Each query covers at most
256 ledgers, uses the RPC's exclusive `endLedger` bound, and follows the RPC
cursor when a response reaches its page limit. Events are decoded with the
Stellar SDK and include the RPC event ID, ledger, close time, transaction hash,
transaction index, and operation index in `metadata`.

Each iterator has its own cursor and cancellation state. It buffers at most one
RPC page and performs no background polling while the consumer is processing a
yielded event. Deduplication uses ledger, transaction hash, transaction index,
operation index, and RPC event ID. This preserves distinct events from the same
transaction and removes repeated results from the one-ledger query overlap.
The in-memory identity set is retained for the active bounded query window and
its overlap ledger, then pruned as the ledger cursor advances. A fresh iterator
has no persisted deduplication state.

Transient network failures, timeouts, server errors, and rate limits are retried
with exponential backoff from one to thirty seconds. Invalid requests and
malformed RPC responses end the iterator with `EscrowEventStreamError`;
retention gaps are surfaced as `kind === "retention_gap"` because the missing
history cannot be recovered from that RPC node. Event payloads that are
malformed or do not match a known escrow event shape are skipped rather than
being emitted as another event type.

Call `return()` to stop a pending iterator, or use `break` from `for await` as
above. This clears the polling wait and aborts an in-flight request made by the
default SDK transport. A custom injected RPC server remains responsible for
its own transport cancellation behavior. Soroban RPC polling is not a
real-time delivery guarantee, and completeness depends on the event history
retained by the selected RPC node.

Polling interval, retry delays, request timeout, page size, and an injectable
RPC server can be supplied as the optional second argument:

```ts
const events = client.watchEscrow(42n, {
  pollIntervalMs: 5_000,
  timeoutMs: 20_000,
});
```
