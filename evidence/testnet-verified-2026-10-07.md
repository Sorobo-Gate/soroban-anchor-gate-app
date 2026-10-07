# Stellar Testnet Live Freighter Verification Report (2026-10-07)

## Executive Summary

This report documents the live, end-to-end interactive verification of the **Freighter Browser Extension Wallet Boundary** and the Next.js Web Dashboard for `Sorobo-Gate/soroban-anchor-gate-app`.

Following the implementation of the Soroban RPC transaction lifecycle, this empirical test verifies that a non-custodial browser wallet (Freighter) successfully connected, passed network passphrase verification, simulated execution, interactively approved and signed the prepared Soroban host function invocation, and achieved authoritative onchain inclusion on Stellar Testnet.

---

## 1. Environment & Live Toolchain Baseline

| Parameter | Authoritative Value | Verification Source |
|---|---|---|
| **Verification Date** | 2026-10-07 | Live Interactive Browser Test |
| **Git Commit Reference** | `2e6ef3d4b5b6bddad2574f87a8de580993e92cab` | Repository `develop` HEAD |
| **Frontend Application** | Next.js 16.3.6 / React 19.2.8 (`apps/web`) | `apps/web/package.json` |
| **Stellar SDK Version** | `@stellar/stellar-sdk@17.2.1` | `package-lock.json` |
| **Freighter API Version** | `@stellar/freighter-api@6.0.1` | `apps/web/package.json` |
| **Connected Wallet Provider** | Freighter Browser Extension (Non-Custodial) | Injected `window.freighter` |
| **Signer Public Address** | `GCHIAK3LLDWJ5N4Z4TH6GHCH2LQX5SUL2WEU42I324CFXGDUWXMNNSDZ` | Freighter Public Key |
| **Stellar Network** | Testnet (`Test SDF Network ; September 2015`) | Verified via `getNetworkDetails()` |
| **Soroban RPC URL** | `https://soroban-testnet.stellar.org` | Official SDF Testnet RPC |
| **Contract ID** | `CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT` | Authoritative Deployed Contract |
| **Token Contract (Native SAC)** | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` | Stellar Asset Contract (XLM SAC) |

---

## 2. Profile Hash Cryptographic Commitment

Prior to building the onchain contract invocation, sensitive off-chain banking routing coordinates were hashed client-side with SHA-256 to ensure data privacy:

- **Algorithm**: Deterministic SHA-256 (`crypto.subtle.digest`)
- **Computed Profile Hash**: `8083a72c0780ebeac2e5348912d51bb0b047ac433860595dd6110ab13d99945a`
- **Byte Length**: Exactly 32 bytes (64 hex characters)
- **Host Function Type**: `xdr.ScVal.scvBytes(32)`

---

## 3. Empirical Transaction Execution Record

| Property | Value |
|---|---|
| **Transaction Hash** | `2392ac9b4de86ac22c6d3b5d10fe12c387e8c9a7ea04217763a2defcf0015e42` |
| **Stellar Expert Explorer** | [`stellar.expert/explorer/testnet/tx/2392ac9b4de86ac22c6d3b5d10fe12c387e8c9a7ea04217763a2defcf0015e42`](https://stellar.expert/explorer/testnet/tx/2392ac9b4de86ac22c6d3b5d10fe12c387e8c9a7ea04217763a2defcf0015e42) |
| **Ledger Sequence** | `5069983` |
| **Confirmation Timestamp** | `2026-10-07T11:45:02Z` |
| **Fee Charged** | `252643` stroops |
| **Source / Payer Account** | `GCHIAK3LLDWJ5N4Z4TH6GHCH2LQX5SUL2WEU42I324CFXGDUWXMNNSDZ` |
| **Beneficiary Account** | `GABFQIK63R2NETJM7T673EAMZN4RJLLGP3OFUEJU5SZVTGWUKULZJNL6` |
| **Locked Token Amount** | `9.9999993` tokens (`99999993` stroops) |
| **Lock Duration** | 604800 seconds (7 days) |
| **Contract Function Invoked** | `create_escrow` |
| **Onchain State Created** | `Escrow #3` instance stored in contract storage |
| **Final RPC Status** | `SUCCESS` |

---

## 4. Verification Boundary Upgrade Matrix

With this live execution, the status of the browser wallet boundary is officially promoted:

| System Boundary | Previous Status | Upgraded Status | Verification Rationale |
|---|---|---|---|
| **Non-Custodial Freighter Extension Boundary** | `UNVERIFIED (REQUIREMENT)` | **`VERIFIED ONCHAIN`** | Live interactive Freighter extension popup confirmed, signed, submitted, and included in ledger `5069983` (`2392ac9b...`). |
| **Frontend Transaction Simulation & Polling** | `VERIFIED IN TESTS` | **`VERIFIED ONCHAIN`** | Real Soroban RPC `simulateTransaction`, fee assembling, and `getTransaction` confirmation polling executed against live network. |
| **Escrow Creation Onchain** | `VERIFIED ONCHAIN` | **`VERIFIED ONCHAIN`** | Escrows #1 (`e0b57482...`), #2 (`b1e24c05...`), and #3 (`2392ac9b...`) verified on Stellar Expert Explorer. |
| **SEP-10 / SEP-31 Endpoint** | `KNOWN LIMITATION` | `KNOWN LIMITATION` | Preserved as honest architectural limitation pending partner anchor availability. |
