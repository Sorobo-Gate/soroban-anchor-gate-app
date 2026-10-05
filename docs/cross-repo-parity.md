# Cross-Repository Parity Matrix

This matrix compares exact smart contract functions and data types in [`Sorobo-Gate/soroban-anchor-gate-contract`](https://github.com/Sorobo-Gate/soroban-anchor-gate-contract) against the application components in `Sorobo-Gate/soroban-anchor-gate-app`.

---

## Matrix Comparison

| Contract Surface | Contract Specification | TS Client (`packages/contract-client`) | Web Frontend (`apps/web`) | Go Relay (`services/relay`) | Parity Status |
|---|---|---|---|---|---|
| **Init Function** | `init(admin, anchor)` | `buildInitTx(admin, anchor)` | Admin setup view | N/A | `VERIFIED` |
| **Create Escrow** | `create_escrow(payer, beneficiary, token, amount: i128, profile_hash: BytesN<32>, lock_duration: u64)` | `buildCreateEscrowTx(...)` | `handleCreateEscrow` | N/A | `VERIFIED` |
| **Release to Anchor** | `release_to_anchor(escrow_id: u64, caller, anchor_disbursement_address)` | `buildReleaseToAnchorTx(...)` | Escrow management view | N/A | `VERIFIED` |
| **Refund Function** | `refund(escrow_id: u64)` | `buildRefundTx(escrowId)` | Refund action view | N/A | `VERIFIED` |
| **Contract State Enum** | `Funded`, `Disbursed`, `Refunded` | `EscrowContractState` | Status lifecycle display | Status tracking | `VERIFIED` |
| **Numeric Domain (Amount)** | `i128` | `bigint` (native bigint string/int) | `parseTokenAmount` base units | `*big.Int` | `VERIFIED` |
| **Numeric Domain (Escrow ID)** | `u64` | `bigint` | `bigint` | `uint64` | `VERIFIED` |
| **Profile Hash** | `BytesN<32>` | SHA-256 64-char hex | `hashRoutingInfo` SHA-256 | `[32]byte` hex check | `VERIFIED` |
| **Contract Event** | `disbursed` topic symbol | `disbursed` event decoder | Event status listener | `disbursed` RPC decoder | `VERIFIED` |
| **Stellar Network** | Testnet | Testnet passphrase | Testnet passphrase | Testnet RPC URL | `VERIFIED` |
| **Contract Address** | Deployed contract ID | Validated contract ID | Configured contract ID | Environment contract ID | `VERIFIED` |
