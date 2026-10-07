<div align="center">

<img src="assets/soroban-anchor-gate-app-banner.png" alt="SorobanAnchor Gate App" width="100%" />

# SorobanAnchor Gate App

Web interface, TypeScript contract client SDK, and Go event relay daemon for SorobanAnchor Gate escrow workflows on Stellar.

[![App & Services CI](https://github.com/Sorobo-Gate/soroban-anchor-gate-app/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/Sorobo-Gate/soroban-anchor-gate-app/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Stellar Testnet](https://img.shields.io/badge/Stellar-Testnet_Verified-08B5E5.svg)](https://stellar.expert/explorer/testnet/contract/CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT)
[![Freighter Verified](https://img.shields.io/badge/Freighter-Verified_Onchain-582CD6.svg)](evidence/testnet-verified-2026-10-07.md)
[![Contract v0.1.1](https://img.shields.io/badge/Contract-v0.1.1-brightgreen.svg)](https://github.com/Sorobo-Gate/soroban-anchor-gate-contract)

[Contract Repository](https://github.com/Sorobo-Gate/soroban-anchor-gate-contract) • [Testnet Evidence](evidence/testnet-verified-2026-10-07.md) • [Evidence Index](evidence/index.md) • [Security](SECURITY.md) • [Contributing](CONTRIBUTING.md)

</div>

---

## What is SorobanAnchor Gate App?

`soroban-anchor-gate-app` is the client and off-chain service monorepo for the SorobanAnchor Gate escrow system. It brings together three coordinated components:

1. **Web Application (`apps/web`)**: A Next.js 16 user interface connecting to Freighter browser extension for interactive milestone escrow configuration, balance simulation, and signing.
2. **Contract Client SDK (`packages/contract-client`)**: A typed TypeScript client wrapping Soroban parameter encoding, integer-safe token scaling, and input validation.
3. **Relay Service (`services/relay`)**: A standalone Go background daemon that monitors Soroban RPC for `disbursed` events and manages a durable, restart-safe event store for off-chain anchor workflows.

The companion smart contract is maintained in [`Sorobo-Gate/soroban-anchor-gate-contract`](https://github.com/Sorobo-Gate/soroban-anchor-gate-contract).

---

## Why it exists

Onchain escrows enforce asset custody and settlement rules with mathematical guarantees. However, practical payouts to real-world recipients require off-chain identity, banking rails, and payment coordination.

Soroban smart contracts execute in an isolated WebAssembly sandbox and cannot directly trigger off-chain banking APIs. Conversely, traditional off-chain payment scripts cannot provide the non-custodial custody guarantees of an onchain escrow.

SorobanAnchor Gate bridges this gap through architectural separation:

- **Soroban controls custody and state**: The smart contract locks tokens, verifies authorization, executes protocol fee splits, and guarantees refunds after expiry.
- **The web application handles user signing**: Users interact through non-custodial browser wallets (Freighter). Private keys never touch web application servers.
- **Privacy remains protected**: Sensitive recipient banking coordinates are hashed into 32-byte SHA-256 commitments (`profile_hash`) client-side before submission. Raw personal identifiable information (PII) is never written to the ledger.
- **The relay observes settlement**: When an escrow is authorized for release, the contract emits a cryptographic `disbursed` event. The Go relay captures this event to coordinate downstream processing.

> **Scope Boundary**: The relay observes and records events into a durable file store. Programmatic SEP-10 challenge authentication and live SEP-31 partner anchor payout dispatch are currently documented design boundaries and tracked for future integration.

---

## Repository structure

```text
soroban-anchor-gate-app/
├── apps/
│   └── web/                   # Next.js 16 frontend & Freighter wallet dashboard
├── packages/
│   └── contract-client/       # TypeScript SDK for Soroban XDR encoding & math
├── services/
│   └── relay/                 # Go event listener daemon & durable event store
├── evidence/                  # Empirical Testnet transaction reports & logs
├── docs/                      # Parity matrices and architectural specifications
└── AUDIT/                     # Branch state and history remediation records
```

---

## Current verification status

| Surface | Implementation Status | Verification Evidence |
| --- | --- | --- |
| **Contract Client SDK** | `VERIFIED` | 13/13 unit tests passing; typed builders and integer math |
| **Escrow Creation Onchain** | `VERIFIED ONCHAIN` | Testnet Tx [`e0b57482...`](https://stellar.expert/explorer/testnet/tx/e0b574823c2c8bd9e8b9e97ae561c69e536fc38b6f61a21553d1f6e27e75980d) and [`2392ac9b...`](https://stellar.expert/explorer/testnet/tx/2392ac9b4de86ac22c6d3b5d10fe12c387e8c9a7ea04217763a2defcf0015e42) |
| **Freighter Extension Boundary** | `VERIFIED ONCHAIN` | Live browser testnet transaction on ledger `5069983` ([Report](evidence/testnet-verified-2026-10-07.md)) |
| **Frontend Simulation & State** | `TESTED LOCALLY` | 21/21 passing Next.js tests; RPC simulation and polling logic |
| **Relay Event Decoder** | `TESTED LOCALLY` | 11/11 Go unit tests passing with `-race`; i128 `*big.Int` decoding |
| **Durable Store & Idempotency** | `TESTED LOCALLY` | 4/4 Go unit tests passing with `-race`; restart recovery and deduplication |
| **SEP-10 / SEP-31 Integration** | `KNOWN LIMITATION` | Tracked in [Issue #1](https://github.com/Sorobo-Gate/soroban-anchor-gate-app/issues/1); partner anchor endpoint pending |

---

## Web application

Located in `apps/web/`, built with **Next.js 16**, **React 19**, and **Tailwind CSS**.

### Key Capabilities
- **Freighter Extension Integration**: Injected wallet discovery, network passphrase verification, and transaction signing via `@stellar/freighter-api`.
- **Real Soroban RPC Lifecycle**: Transaction preparation, host simulation (`simulateTransaction`), fee assembling, wallet signing, and polling (`getTransaction`). No simulated timeouts or mock transactions.
- **Client-Side SHA-256 Hashing**: Generates 32-byte profile hashes from banking metadata using the Web Cryptography API (`crypto.subtle`).
- **Integer-Safe Base Units**: Scales human-readable decimal inputs into 7-decimal integer stroops using native `bigint`.
- **Deterministic State Flow**: Progression: `idle` → `wallet-required` → `preparing` → `simulating` → `awaiting-signature` → `submitting` → `pending` → `confirmed` / `failed`.

---

## Contract client SDK

Located in `packages/contract-client/`, providing a typed interface for building contract invocations:

### Key Capabilities
- **Parameter Builders**: Construct parameter XDR arrays for `init(admin, treasury, fee_bps)`, `create_escrow`, `release_to_anchor`, and `refund`.
- **Address Validation**: Validates Ed25519 public keys (`G...`), Soroban contract IDs (`C...`), and 32-byte hex hashes.
- **Checked Token Scaling**: `parseTokenAmount` and `formatTokenAmount` prevent floating-point rounding errors.
- **Parity with Contract Types**: Maps directly to contract storage keys, error enums, and data types.

---

## Relay service

Located in `services/relay/`, written in **Go 1.22+**.

### Key Capabilities
- **Event Subscriber**: Polls `getEvents` on Soroban RPC for `disbursed` topic symbols matching the authoritative contract ID.
- **Arbitrary Precision Decoding**: Decodes i128 payout amounts directly into `math/big.Int` to eliminate truncation or numeric overflow.
- **Durable File Store**: Thread-safe, atomic-write JSON persistence with crash recovery and explicit event lifecycle states (`observed` → `claimed` → `processing` → `completed` / `failed`).
- **Ledger Cursor Tracking**: Persists the highest observed ledger sequence to resume scanning reliably across restarts.

---

## Transaction flow

```text
1. User enters escrow terms and banking coordinates in web app
2. Browser calculates SHA-256 hash of coordinates (PII stays local)
3. Web app simulates create_escrow host function against Soroban RPC
4. Freighter browser extension prompts user for signature
5. Signed transaction submitted to Stellar Testnet (funds locked)
6. Escrow state transitions to FUNDED in contract storage
7. Upon milestone approval, release_to_anchor is authorized
8. Contract disburses funds (fee to treasury, remainder to anchor address)
9. Contract emits ("disbursed", escrow_id) event with profile_hash
10. Relay daemon observes event, decodes payout, and records to durable store
```

---

## Verified Testnet evidence

The web interface and contract client have been verified live against the authoritative Testnet deployment:

- **Contract ID**: [`CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT`](https://stellar.expert/explorer/testnet/contract/CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT)
- **Token Contract (Native SAC)**: `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`
- **Freighter Verification Transaction**: [`2392ac9b4de86ac22c6d3b5d10fe12c387e8c9a7ea04217763a2defcf0015e42`](https://stellar.expert/explorer/testnet/tx/2392ac9b4de86ac22c6d3b5d10fe12c387e8c9a7ea04217763a2defcf0015e42)
- **Confirmation Ledger**: `5069983`
- **Network**: Stellar Testnet (`Test SDF Network ; September 2015`)

Empirical verification logs:
- [`evidence/testnet-verified-2026-10-07.md`](evidence/testnet-verified-2026-10-07.md): Authoritative Freighter browser wallet verification report.
- [`evidence/testnet-verified-2026-10-06.md`](evidence/testnet-verified-2026-10-06.md): Authoritative contract redeployment verification.
- [`evidence/index.md`](evidence/index.md): Full claim verification matrix and status definitions.

---

## Quick start

### Prerequisites
- Node.js >= 22.12.0
- Go >= 1.22
- Freighter browser extension installed

### 1. Web Application
```bash
cd apps/web
npm install
npm run dev
# Open http://localhost:3000
```

### 2. Contract Client SDK
```bash
cd packages/contract-client
npm install
npm run build
```

### 3. Relay Service
```bash
cd services/relay
go build -o relay cmd/relay/main.go
# Run with environment variables:
SOROBAN_RPC_URL="https://soroban-testnet.stellar.org" \
CONTRACT_ID="CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT" \
./relay
```

---

## Testing

Each component maintains automated verification suites:

```bash
# Web application unit tests & typechecking
cd apps/web
npm run typecheck
npm run test

# Contract client SDK tests
cd packages/contract-client
npm run typecheck
npm run test

# Relay daemon tests with Go race detector
cd services/relay
go vet ./...
go test -v -race ./...
```

---

## Security and privacy

- **Non-Custodial**: Neither the frontend nor the SDK collects, stores, or handles private keys. All signing takes place within the user's Freighter extension.
- **Off-chain Routing Privacy**: Recipient banking information is never submitted to Soroban RPC or written to the blockchain. Only deterministic 32-byte SHA-256 hashes are recorded onchain.
- **Relay Secret Safeguards**: Relay operational secrets should be supplied through a secure runtime secret store or deployment environment and must never be committed to version control.
- **Audit Status**: Neither the application components nor the smart contracts have undergone a third-party security audit. All deployments are restricted to Stellar Testnet.

For vulnerability disclosure details, see [`SECURITY.md`](SECURITY.md).

---

## Limitations

- **SEP-10 Challenge Authentication**: The relay does not currently complete automated SEP-10 challenge signing with partner anchors ([Issue #1](https://github.com/Sorobo-Gate/soroban-anchor-gate-app/issues/1)).
- **SEP-31 Payment Dispatch**: Direct HTTP dispatch to SEP-31 anchor payment endpoints remains future work.
- **Testnet Only**: The deployment targets Stellar Testnet; no Mainnet deployment exists.

---

## Contributing

Please review [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening issues or pull requests. All contributions must target the `develop` branch.

---

## Roadmap

- [ ] Automated SEP-10 challenge authentication daemon
- [ ] Direct SEP-31 partner payment dispatch pipeline
- [ ] Interactive escrow release and refund controls in web UI
- [ ] Multi-token balance display and SAC whitelisting
- [ ] Formal third-party security audit prior to Mainnet consideration

---

## License

Licensed under the [Apache License 2.0](LICENSE).
