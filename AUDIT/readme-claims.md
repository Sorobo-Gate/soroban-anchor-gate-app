# README Claims Verification Audit

## Overview
This audit matrix validates claims against real code, automated test coverage, and empirical testnet observations, updated during the Second Deep Remediation.

---

| Claim in README / Architecture | Implementation | Test Coverage | Live Evidence | Status | Audit Finding & Action Taken |
|---|---|---|---|---|---|
| **"Automated SEP Bridge"** | Conceptual SEP flow outline | Logic unit tests | N/A | `KNOWN LIMITATION` | Softened to "Soroban Escrow & Anchor Bridge Interface" |
| **"SEP-1 Anchor Discovery"** | Static domain lookup outline | N/A | N/A | `UNVERIFIED` | Moved to planned roadmap features |
| **"SEP-10 Web Authentication"** | Challenge-response specification | Unit test structure | N/A | `PLANNED` | Softened to planned anchor authentication |
| **"SEP-12 KYC Submission"** | Customer profile schema | N/A | N/A | `UNVERIFIED` | Softened to off-chain KYC commitment |
| **"SEP-31 Cross-Border Payout"** | Payout coordinate hashing | `apps/web/src/lib/crypto.test.ts` | Testnet SHA-256 hash | `TESTED LOCALLY` | Real SHA-256 `e0a9e37d...` tested and committed |
| **"SEP-38 RFQ Quotes"** | FX rate calculation | Display calculator | Web console UI | `LOGICALLY COVERED` | Documented as client fee/payout estimator |
| **"Real-Time Event Listener"** | Go RPC poller (`PollEvents`) | `internal/listener/subscriber_test.go` | Go test suite | `TESTED LOCALLY` | 11 tests passing with `-race`, real XDR event decoding |
| **"Idempotency & Deduplication"** | `DurableFileStore` event tracker | `internal/store/idempotency_test.go` | Go test suite | `TESTED LOCALLY` | Crash recovery, 4 states (`observed`, `claimed`, `processing`, `completed`) |
| **"Ledger Cursor Persistence"** | `DurableFileStore` sequence tracking | `internal/store/idempotency_test.go` | Go test suite | `TESTED LOCALLY` | Persisted to JSON file, monotonic cursor advance |
| **"Non-Custodial Wallet"** | Freighter wallet API integration | SDK & Web tests | Live Browser testnet tx `2392ac9b...` (ledger 5069983) | `VERIFIED ONCHAIN` | Live Freighter connection, network verification, and interactive signing verified onchain |
| **"Mainnet / Testnet Support"** | Configurable RPC & network passphrase | SDK & Web tests | Stellar Testnet RPC | `VERIFIED` | Config validation and network passphrase check |
| **"Deployed Contract ID"** | `CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT` | `packages/contract-client/src/index.test.ts` | Stellar Expert Explorer | `VERIFIED ONCHAIN` | Updated to authoritative redeployment `CBIHLECK...` (Tx `00002789...`, init `1ee57cf0...`, WASM hash `ba9eaef2...`) |
| **"PostgreSQL Database"** | PostgreSQL schema references | N/A | N/A | `BLOCKED` / `UNVERIFIED` | Replaced with durable disk-backed file store (`DurableFileStore`) in daemon |
