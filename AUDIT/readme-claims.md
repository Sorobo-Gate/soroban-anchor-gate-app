# README Claims Verification Audit

| Claim in Original README | Implementation | Test Coverage | Live Evidence | Status | Action Taken |
|---|---|---|---|---|---|
| **"Automated SEP Bridge"** | Conceptual SEP flow outline | Logic unit tests | N/A | `KNOWN LIMITATION` | Softened to "Soroban Escrow & Anchor Bridge Interface" |
| **"SEP-1 Anchor Discovery"** | Static domain lookup outline | N/A | N/A | `UNVERIFIED` | Moved to planned roadmap features |
| **"SEP-10 Web Authentication"** | Challenge-response specification | Unit test structure | N/A | `PLANNED` | Softened to planned anchor authentication |
| **"SEP-12 KYC Submission"** | Customer profile schema | N/A | N/A | `UNVERIFIED` | Softened to off-chain KYC commitment |
| **"SEP-31 Cross-Border Payout"** | Payout coordinate hashing | `computeProfileHash` tests | Testnet SHA-256 hash | `TESTED LOCALLY` | Documented as 32-byte `profile_hash` commitment |
| **"SEP-38 RFQ Quotes"** | FX rate calculation | Display calculator | Web console UI | `LOGICALLY COVERED` | Documented as client fee/payout estimator |
| **"Real-Time Event Listener"** | Go RPC poller (`PollEvents`) | `subscriber_test.go` | Go test suite | `TESTED LOCALLY` | Verified RPC poller for `disbursed` events |
| **"Idempotency & Deduplication"** | `MemoryStore` event tracker | `idempotency_test.go` | Go test suite | `TESTED LOCALLY` | Verified duplicate event rejection |
| **"Ledger Cursor Persistence"** | `MemoryStore` sequence tracking | `idempotency_test.go` | Go test suite | `TESTED LOCALLY` | Verified non-regressive ledger cursor |
| **"Non-Custodial Wallet"** | Freighter wallet API integration | SDK & Web tests | Browser wallet connection | `VERIFIED` | Verified no secret key custody |
| **"Mainnet / Testnet Support"** | Configurable RPC & network passphrase | SDK & Web tests | Stellar Testnet RPC | `VERIFIED` | Verified on Stellar Testnet |
| **"Deployed Contract ID"** | `CCCSLE7UN2FRLB2HQWEUEXM4365NDYH3QSC6J5TILQWBSTTIDKFWXX2Y` | SDK tests | Stellar Expert Explorer | `VERIFIED` | Verified active testnet deployment |
| **"PostgreSQL Database"** | PostgreSQL schema references | N/A | N/A | `BLOCKED` / `UNVERIFIED` | Replaced with load-bearing in-memory store in MVP daemon |
