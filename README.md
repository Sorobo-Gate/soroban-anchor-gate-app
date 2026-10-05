# SorobanAnchor Gate App Monorepo

[![App & Services CI](https://github.com/Sorobo-Gate/soroban-anchor-gate-app/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/Sorobo-Gate/soroban-anchor-gate-app/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**SorobanAnchor Gate** is an open-source Stellar application monorepo that connects Soroban smart contract milestone escrows with off-chain Stellar anchor banking gateways.

Related Smart Contract Repository: [`Sorobo-Gate/soroban-anchor-gate-contract`](https://github.com/Sorobo-Gate/soroban-anchor-gate-contract)

---

## 🏗️ Repository Architecture

This repository is structured as a clean monorepo containing three core packages:

```
soroban-anchor-gate-app/
├── apps/
│   └── web/                   # Next.js 16 web dashboard & Freighter wallet console
├── packages/
│   └── contract-client/       # TypeScript SDK with integer-safe math & contract encoders
└── services/
    └── relay/                 # Go background daemon polling Soroban RPC for events
```

---

## 💻 1. Frontend Web Dashboard (`apps/web`)

Built with **Next.js 16**, **React 19**, and **Tailwind CSS**.

### ✨ Features
- **Freighter Wallet Integration**: Connect wallet, verify network passphrase, and sign transactions via `@stellar/freighter-api`.
- **SHA-256 Profile Hashing**: Hashes banking routing info into a 32-byte `profile_hash` commitment on client. Raw PII is never stored onchain.
- **Integer-Safe Token Math**: Convert token amounts to 7-decimal integer base units using `bigint`.
- **Precise Status Semantics**: Status progression: `idle` → `wallet-required` → `preparing` → `simulating` → `awaiting-signature` → `submitting` → `pending` → `confirmed` / `failed`.
- **Contract Parity Lifecycle**: Displays `Funded → Disbursed → Refunded` matching authoritative Soroban contract states.

### 🚀 Getting Started
```bash
cd apps/web
npm install
npm run typecheck
npm run build
npm run dev
```

---

## 📦 2. TypeScript Contract Client SDK (`packages/contract-client`)

Narrowly scoped SDK for interacting with the `SorobanAnchor Gate` contract.

### ✨ Features
- **Invocation Builders**: Build parameter XDR arrays for `init`, `create_escrow`, `release_to_anchor`, and `refund`.
- **Validation Helpers**: Validate Ed25519 public keys, contract addresses, and 32-byte hex profile hashes.
- **Integer-Safe Math**: `parseTokenAmount` and `formatTokenAmount` helpers avoiding JS floating-point rounding errors.

### 🧪 Running Tests & Build
```bash
cd packages/contract-client
npm install
npm run typecheck
npm run test
npm run build
```

---

## ⚙️ 3. Go Relay Daemon (`services/relay`)

Background service written in **Go 1.22+** that monitors Soroban RPC for contract events.

### ✨ Features
- **Soroban Event Listener**: Periodically queries `getEvents` on Soroban RPC for `disbursed` events.
- **Full Domain Numeric Precision**: Decodes token payout amounts into `math/big.Int` without integer truncation.
- **Idempotency Store**: Thread-safe memory store preventing duplicate processing of event IDs.
- **Ledger Cursor Tracking**: Persists and advances ledger sequence cursor across polling windows.

### 🧪 Running Tests & Build
```bash
cd services/relay
go vet ./...
go test -v -race ./...
go build ./cmd/relay/main.go
```

---

## 📑 Implementation & Audit Status Summary

| Surface / Feature | Implementation Status | Verification Details |
|---|---|---|
| **Soroban Escrow SDK** | `VERIFIED` | 10/10 unit tests passing |
| **Freighter Wallet Flow** | `VERIFIED` | Client-side wallet access & signing |
| **Go Event Poller** | `TESTED LOCALLY` | RPC event listener & `disbursed` decoder tests passing |
| **Idempotency & Cursor** | `TESTED LOCALLY` | Thread-safe store tests passing |
| **SEP-10 / SEP-31 Integration** | `KNOWN LIMITATION` | Requires active anchor partner endpoint |

For detailed audit logs and security policies, see:
- [`AUDIT/branch-state.md`](AUDIT/branch-state.md)
- [`AUDIT/git-history-remediation.md`](AUDIT/git-history-remediation.md)
- [`AUDIT/readme-claims.md`](AUDIT/readme-claims.md)
- [`docs/contract-parity.md`](docs/contract-parity.md)
- [`docs/cross-repo-parity.md`](docs/cross-repo-parity.md)
- [`SECURITY.md`](SECURITY.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md)

---

## 📄 License

Licensed under the [Apache License 2.0](LICENSE).
