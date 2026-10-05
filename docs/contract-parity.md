# Smart Contract Parity Specification

This document details the function, argument, type, event, and state parity between the authoritative Soroban contract repository [`Sorobo-Gate/soroban-anchor-gate-contract`](https://github.com/Sorobo-Gate/soroban-anchor-gate-contract) and this application repository (`apps/web`, `packages/contract-client`, `services/relay`).

---

## 1. Public Contract Functions & Signatures

| Function | Contract Arguments | TypeScript SDK Method (`packages/contract-client`) | Description |
|---|---|---|---|
| `init` | `admin: Address, anchor_address: Address` | `buildInitTx(admin, anchor)` | Initializes contract admin and anchor parameters |
| `create_escrow` | `payer: Address`, `beneficiary: Address`, `token: Address`, `amount: i128`, `profile_hash: BytesN<32>`, `lock_duration: u64` | `buildCreateEscrowTx({ payer, beneficiary, token, amount, profileHashHex, lockDurationSeconds })` | Locks token deposit in escrow with 32-byte profile commitment |
| `release_to_anchor` | `escrow_id: u64`, `caller: Address`, `anchor_disbursement_address: Address` | `buildReleaseToAnchorTx({ escrowId, caller, anchorDisbursementAddress })` | Releases escrow funds to anchor disbursement address |
| `refund` | `escrow_id: u64` | `buildRefundTx(escrowId)` | Refunds locked escrow to payer after lock duration expires |

---

## 2. Onchain Escrow State Lifecycle

The smart contract uses three explicit state variants:

```mermaid
stateDiagram-v2
    [*] --> Funded: create_escrow
    Funded --> Disbursed: release_to_anchor
    Funded --> Refunded: refund (after lock_duration)
```

| State Variant | Description | UI Representation |
|---|---|---|
| `Funded` | Tokens locked in escrow contract | `Funded` |
| `Disbursed` | Escrow released to anchor for off-ramp payout | `Disbursed` |
| `Refunded` | Escrow returned to depositor after timelock | `Refunded` |

> ⚠️ **State Correction**: The app previously rendered `Funded → Disbursed → Settled`. The contract contains **no `Settled` variant**. The frontend status display has been updated to strictly reflect `Funded → Disbursed → Refunded`.

---

## 3. Soroban Event Specification

| Contract Event Topic | Topic XDR Symbol | Payload Type | Relay Listener Topic (`services/relay`) |
|---|---|---|---|
| `disbursed` | `Symbol("disbursed")` | `(escrow_id: u64, amount: i128, profile_hash: BytesN<32>)` | `disbursed` |

> ⚠️ **Relay Correction**: The Go relay service previously logged polling for `DisbursementAuthorized`. The contract emits `disbursed`. The Go listener has been updated to decode `disbursed` events.

---

## 4. Numeric & Data Domain Mapping

| Data Field | Contract Type | SDK / TypeScript Type | Go Relay Type | Boundary Enforcement |
|---|---|---|---|---|
| `amount` | `i128` | `bigint` (native bigint string/int) | `*big.Int` | Integer-safe conversion; no JS floating-point for transaction construction |
| `escrow_id` | `u64` | `bigint` | `uint64` | Native unsigned 64-bit integer |
| `lock_duration` | `u64` | `bigint` | `uint64` | Seconds |
| `profile_hash` | `BytesN<32>` | `string` (64-char hex / 32 bytes) | `[32]byte` | Strictly validated 32-byte SHA-256 digest |
