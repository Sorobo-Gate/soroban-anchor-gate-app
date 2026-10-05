# Go Relay Daemon Architecture & Operations

## Overview

The Go Relay service (`services/relay`) monitors the Soroban blockchain for smart contract events emitted by the `SorobanAnchor Gate` contract and bridges off-chain anchor banking infrastructure.

## Key Features

1. **RPC Event Poller**: Queries `getEvents` on Soroban RPC at regular intervals (4s ticker).
2. **Typed Event Decoder**: Decodes `disbursed` events, extracting `escrow_id`, `payout_amount` (using `math/big.Int` to prevent integer truncation across the full `i128` numeric domain), `profile_hash_hex`, and `contract_id`.
3. **Durable File Store & Idempotency**: Thread-safe durable file store (`DurableFileStore`) persisting event states (`observed` → `claimed` → `processing` → `completed` / `failed`) to disk across daemon restarts and crashes.
4. **Ledger Cursor Persistence**: Tracks the latest processed ledger sequence number on disk, ensuring the daemon resumes without skipping or re-reading ledger windows.
5. **Graceful Shutdown**: Intercepts `os.Interrupt` and `SIGTERM` signals for clean lifecycle termination.

## Configuration Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SOROBAN_CONTRACT_ID` | Yes | `CD36A2JQEEQSBTKOE6T5PB3BPV7IGIYDSSOBOOK6NE4RSOWGNC2HXXDA` | Deployed Soroban escrow contract ID |
| `SOROBAN_RPC_URL` | Yes | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint URL |
| `START_LEDGER` | No | `1` | Starting ledger sequence for event query window |
| `RELAY_STORE_PATH` | No | `""` (in-memory) or path | Durable file path for event state and cursor persistence |

## Testing

```bash
cd services/relay
go vet ./...
go test -v -race ./...
```
