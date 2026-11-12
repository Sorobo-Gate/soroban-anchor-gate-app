<div align="center">

<img src="assets/soroban-anchor-gate-app-banner.png" alt="SorobanAnchor Gate App" width="100%" />

# SorobanAnchor Gate App

Web interface, TypeScript contract client SDK, and Go event relay daemon for SorobanAnchor Gate escrow workflows on Stellar.

[![App & Services CI](https://github.com/Sorobo-Gate/soroban-anchor-gate-app/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/Sorobo-Gate/soroban-anchor-gate-app/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Stellar Testnet](https://img.shields.io/badge/Stellar-Testnet_Verified-08B5E5.svg)](https://stellar.expert/explorer/testnet/contract/CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT)
[![Freighter Verified](https://img.shields.io/badge/Freighter-Verified_Onchain-582CD6.svg)](evidence/testnet-verified-2026-10-07.md)
[![WASM](https://img.shields.io/badge/WASM-12.3%20KB-08B5E5.svg)](docs/gas-benchmarks.md)
[![Tests](https://img.shields.io/badge/Tests-91%20passing-brightgreen.svg)](#testing)

[Smart Contracts](contracts/) • [Testnet Evidence](evidence/testnet-verified-2026-10-07.md) • [Gas Benchmarks](docs/gas-benchmarks.md) • [Security](SECURITY.md) • [Contributing](CONTRIBUTING.md)

</div>

---

## What is SorobanAnchor Gate App?

`soroban-anchor-gate-app` is the client and off-chain service monorepo for the SorobanAnchor Gate escrow system. It brings together four coordinated components:

1. **Smart Contracts (`contracts/`)**: Soroban milestone escrow smart contracts in Rust with multi-token SAC whitelisting, arbiter dispute mediation, and protocol fee mechanics.
2. **Web Application (`apps/web`)**: A Next.js 16 user interface connecting to Freighter browser extension for interactive milestone escrow configuration, deposit, release, refund, dispute resolution, and balance simulation.
3. **Contract Client SDK (`packages/contract-client`)**: A typed TypeScript client wrapping Soroban parameter encoding, integer-safe token scaling, dispute builders, and input validation.
4. **Relay Service (`services/relay`)**: A standalone Go background daemon that monitors Soroban RPC for `disbursed` events, manages a durable restart-safe event store, executes SEP-10 challenge authentication, provides HTTP monitoring endpoints (`/health`, `/status`, `/events`), and auto-recovers from RPC ledger retention bounds.

The Soroban smart contract is natively maintained directly within this monorepo in [`contracts/`](contracts/), providing unified CI, end-to-end testing, and tight type parity with the SDK and web client.

---

## Why it exists

Onchain escrows enforce asset custody and settlement rules with mathematical guarantees. However, practical payouts to real-world recipients require off-chain identity, banking rails, and payment coordination.

Soroban smart contracts execute in an isolated WebAssembly sandbox and cannot directly trigger off-chain banking APIs. Conversely, traditional off-chain payment scripts cannot provide the non-custodial custody guarantees of an onchain escrow.

SorobanAnchor Gate bridges this gap through architectural separation:

- **Soroban controls custody and state**: The smart contract locks tokens, verifies authorization, executes protocol fee splits, and guarantees refunds after expiry.
- **The web application handles user signing**: Users interact through non-custodial browser wallets (Freighter). Private keys never touch web application servers.
- **Privacy remains protected**: Sensitive recipient banking coordinates are hashed into 32-byte SHA-256 commitments (`profile_hash`) client-side before submission. Raw personal identifiable information (PII) is never written to the ledger.
- **The relay observes settlement**: When an escrow is authorized for release, the contract emits a cryptographic `disbursed` event. The Go relay captures this event to coordinate downstream processing.

> **Scope Boundary**: The relay observes and records events into a durable file store with automated SEP-10 web authentication and HTTP health/status monitoring endpoints (`/health`, `/status`, `/events`). Direct programmatic dispatch to partner anchor SEP-31 payment APIs is a documented design boundary and tracked for future integration.

---

## Repository structure

```text
soroban-anchor-gate/
├── contracts/                 # Soroban milestone escrow smart contracts & Makefile
├── apps/
│   └── web/                   # Next.js 16 frontend & Freighter wallet dashboard
├── packages/
│   └── contract-client/       # TypeScript SDK for Soroban XDR encoding & math
├── services/
│   └── relay/                 # Go event listener daemon & durable event store
├── deployment/                # Docker compose configs & deployment manifests
├── install.sh                 # One-click automated setup & verification script
├── package.json               # Root monorepo orchestrator (install, dev, build, test)
├── Makefile                   # Top-level Makefile for all components
├── evidence/                  # Empirical Testnet transaction reports & logs
├── docs/                      # Parity matrices and architectural specifications
└── AUDIT/                     # Branch state and history remediation records
```

---

## Current verification status

| Surface | Implementation Status | Verification Evidence |
| --- | --- | --- |
| **Smart Contracts (Rust)** | `VERIFIED` | 27/27 Soroban tests passing; dispute resolution, token whitelist, and getters |
| **Contract Client SDK** | `VERIFIED` | 16/16 unit tests passing; typed builders, integer math, and dispute splits |
| **Escrow Creation Onchain** | `VERIFIED ONCHAIN` | Testnet Tx [`e0b57482...`](https://stellar.expert/explorer/testnet/tx/e0b574823c2c8bd9e8b9e97ae561c69e536fc38b6f61a21553d1f6e27e75980d) and [`2392ac9b...`](https://stellar.expert/explorer/testnet/tx/2392ac9b4de86ac22c6d3b5d10fe12c387e8c9a7ea04217763a2defcf0015e42) |
| **Freighter Extension Boundary** | `VERIFIED ONCHAIN` | Live browser testnet transaction on ledger `5069983` ([Report](evidence/testnet-verified-2026-10-07.md)) |
| **Frontend Simulation & State** | `TESTED LOCALLY` | 24/24 passing Next.js tests; interactive deposit, release, refund, and dispute flows |
| **Relay Event Decoder** | `TESTED LOCALLY` | 11/11 Go unit tests passing with `-race`; i128 `*big.Int` decoding |
| **Relay SEP-10 Authentication** | `TESTED LOCALLY` | 4/4 Go unit tests passing; challenge signing, JWT exchange, and cache expiry |
| **Durable Store & Idempotency** | `TESTED LOCALLY` | 4/4 Go unit tests passing with `-race`; restart recovery and deduplication |
| **Relay HTTP API Monitoring** | `TESTED LOCALLY` | 2/2 Go unit tests passing; `/health`, `/status`, and `/events` endpoints |
| **Relay RPC Auto-Recovery** | `TESTED LOCALLY` | 3/3 Go unit tests passing; ledger retention bounds auto-recovery and tip initialization |

---

## Smart contracts

Located in `contracts/`, written in **Rust** using the **Soroban SDK v22.0.11**.

### Key Capabilities
- **Arbiter Dispute Resolution**: `resolve_dispute(env, escrow_id, caller, payer_bps, beneficiary_bps)` enables designated arbiters to mediate payment disputes. Strictly enforces that split basis points sum to exactly `10,000` (100.00%).
- **Multi-Token Whitelisting**: `set_token_whitelist` and `is_token_whitelisted` restrict deposits to verified Stellar Asset Contract (SAC) tokens (e.g. USDC, EURC).
- **Onchain Query Getters**: Public read methods (`get_escrow`, `get_counter`, `get_admin`, `get_treasury`, `get_fee_bps`) enable transparent querying directly from RPC.
- **Gas Optimized & Compact**: Compiles to an optimized **12.3 KB** release WASM (`12,306 bytes`, SHA-256 `55f9b1a9...`). See [`docs/gas-benchmarks.md`](docs/gas-benchmarks.md) for full CPU instruction and memory benchmarks.

---

## Web application

Located in `apps/web/`, built with **Next.js 16**, **React 19**, and **Tailwind CSS**.

### Key Capabilities
- **Freighter Extension Integration**: Injected wallet discovery, network passphrase verification, and transaction signing via `@stellar/freighter-api`.
- **Interactive Escrow Lifecycle**: Full dashboard controls for milestone escrow creation, anchor release authorization, lock expiry refund, and arbiter dispute resolution.
- **Real Soroban RPC Lifecycle**: Transaction preparation, host simulation (`simulateTransaction`), fee assembling, wallet signing, and polling (`getTransaction`). No simulated timeouts or mock transactions.
- **Client-Side SHA-256 Hashing**: Generates 32-byte profile hashes from banking metadata using the Web Cryptography API (`crypto.subtle`).
- **Integer-Safe Base Units**: Scales human-readable decimal inputs into 7-decimal integer stroops using native `bigint`.
- **Modern Brand & Nautical Styling**: Official anchor emblem and deep nautical theme (`#070d1e`, `#0c1527`, `#0284c7`, `#38bdf8`), strictly calibrated for accessibility and contrast.
- **Deterministic Offline Builds**: Static prerendering with system font fallbacks, ensuring zero external network dependencies during production builds (`npm run build`).
- **Deterministic State Flow**: Progression: `idle` → `wallet-required` → `preparing` → `simulating` → `awaiting-signature` → `submitting` → `pending` → `confirmed` / `failed`.

---

## Contract client SDK

Located in `packages/contract-client/`, providing a typed interface for building contract invocations:

### Key Capabilities
- **Parameter Builders**: Construct parameter XDR arrays for `init(admin, treasury, fee_bps)`, `create_escrow`, `release_to_anchor`, `refund`, `resolve_dispute`, and `set_token_whitelist`.
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
- **SEP-10 Web Authentication Client**: Automatic challenge-response handshake with Ed25519 signing and in-memory JWT token cache with expiry.
- **Embedded HTTP Monitoring API**: Exposes `/health`, `/status`, and `/events` endpoints on port 8080 with graceful shutdown for health checking and scraper ingestion.
- **Soroban RPC Auto-Recovery**: Automatically detects Soroban RPC retention window bounds (error `-32600`) and fast-forwards the cursor to the active retention window or queries `getLatestLedger` to resume event streaming without stalling.

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

### Automated Bootstrap (Recommended)
Clone the repository and run the automated bootstrap script. It validates Node.js, Go, Rust, Soroban CLI, installs the `wasm32-unknown-unknown` target, sets up environment templates, and installs all dependencies:

```bash
./install.sh
```

### Manual Installation
```bash
# Install dependencies across all packages and services
npm run install:all
# or
make install
```

### Running Locally
```bash
# Start Next.js web application and Go relay daemon concurrently:
npm run dev

# Or using Docker Compose:
docker compose up --build
```
- Web Application: `http://localhost:3000`
- Soroban Testnet Contract: `CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT`

---

## Testing

Run all automated test suites across all 4 architectural layers with a single command:

```bash
npm test
# or
make test
```

| Layer | Command | Tests | Status |
| --- | --- | --- | --- |
| **Smart Contracts** | `cd contracts && cargo test` | 27 Soroban lifecycle tests | `PASSING` |
| **Contract Client SDK** | `cd packages/contract-client && npm test` | 16 TypeScript SDK tests | `PASSING` |
| **Web Application** | `cd apps/web && npm test` | 24 Next.js transaction tests | `PASSING` |
| **Relay Service** | `cd services/relay && go test -v -race ./...` | 24 Go race, API, SEP-10 & RPC tests | `PASSING` |
| **Total Test Suite** | `npm test` | **91 Automated Tests** | `100% PASSING` |

---

## 🌊 Stellar Drips Wave Program

SorobanAnchor Gate is architected as an active **Maintainer Project** within the **Stellar Drips Wave Program**.

* **Gas & WASM Profiling**: [`docs/gas-benchmarks.md`](docs/gas-benchmarks.md) (Compiled WASM size: 12.3 KB)
* **Sprint Issues**: Contributors can browse issues labeled `drips-wave` with point valuations:
  - `wave:trivial` (100 pts)
  - `wave:medium` (150 pts)
  - `wave:high` (200 pts)
* **Contribution Workflow**: See [`CONTRIBUTING.md`](CONTRIBUTING.md) for branch naming (`wave/<issue-number>-<name>`), testing requirements, and PR review standards.

---

## Security and privacy

- **Non-Custodial**: Neither the frontend nor the SDK collects, stores, or handles private keys. All signing takes place within the user's Freighter extension.
- **Off-chain Routing Privacy**: Recipient banking information is never submitted to Soroban RPC or written to the blockchain. Only deterministic 32-byte SHA-256 hashes are recorded onchain.
- **Relay Secret Safeguards**: Relay operational secrets should be supplied through a secure runtime secret store or deployment environment and must never be committed to version control.
- **Audit Status**: Neither the application components nor the smart contracts have undergone a third-party security audit. All deployments are restricted to Stellar Testnet.

For vulnerability disclosure details, see [`SECURITY.md`](SECURITY.md).

---

## Limitations

- **SEP-31 Payment Dispatch**: Direct HTTP dispatch to partner anchor SEP-31 payment endpoints remains future work.
- **Testnet Only**: The deployment targets Stellar Testnet; no Mainnet deployment exists.

---

## Contributing

Please review [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening issues or pull requests. All contributions must target the `develop` branch.

---

## Roadmap

- [x] Automated SEP-10 challenge authentication client & token cache
- [x] Interactive escrow release, refund, and dispute controls in web UI
- [x] Multi-token SAC asset whitelisting onchain and client SDK
- [x] Embedded HTTP monitoring API in relay service (`/health`, `/status`, `/events`)
- [x] Soroban RPC ledger retention auto-recovery and tip initialization
- [x] Gas invocation profiling and WASM size benchmarking (12.3 KB)
- [ ] Direct SEP-31 partner payment dispatch pipeline
- [ ] Formal third-party security audit prior to Mainnet consideration

---

## License

Licensed under the [Apache License 2.0](LICENSE).
