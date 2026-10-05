# Stellar Testnet Empirical Verification Report (2026-10-05)

## Executive Summary

This report documents the empirical onchain verification conducted during the Second Deep Remediation of `Sorobo-Gate/soroban-anchor-gate-app`. Prior claims of Testnet execution were identified as synthetic or simulated (see [`evidence/testnet-2026-10-05.md`](./testnet-2026-10-05.md)). This document provides cryptographic and ledger proof of live Soroban invocation on Stellar Testnet, matching the verified deployment in `Sorobo-Gate/soroban-anchor-gate-contract`.

---

## 1. Network & Deployment Credentials

| Parameter | Authoritative Value | Verification Source |
|---|---|---|
| **Network Name** | Stellar Testnet | Protocol 22 / Soroban |
| **Network Passphrase** | `Test SDF Network ; September 2015` | Canonical Testnet Passphrase |
| **Soroban RPC URL** | `https://soroban-testnet.stellar.org` | Official SDF Testnet RPC |
| **Escrow Contract ID** | `CD36A2JQEEQSBTKOE6T5PB3BPV7IGIYDSSOBOOK6NE4RSOWGNC2HXXDA` | `soroban-anchor-gate-contract` deployment |
| **Asset / Token Contract** | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` | Native XLM Stellar Asset Contract (SAC) |
| **Stellar Expert Contract** | [`stellar.expert/explorer/testnet/contract/CD36A2JQEEQSBTKOE6T5PB3BPV7IGIYDSSOBOOK6NE4RSOWGNC2HXXDA`](https://stellar.expert/explorer/testnet/contract/CD36A2JQEEQSBTKOE6T5PB3BPV7IGIYDSSOBOOK6NE4RSOWGNC2HXXDA) | Public Explorer |

---

## 2. Profile Hash Cryptographic Verification

In the previous artifact, the profile hash was reported as `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` for `IBAN: DE89370400440532013000 / BIC: COBADEFFXXX`. Cryptographic analysis reveals `e3b0c442...` is strictly the SHA-256 digest of an empty byte array (`""`).

### Authoritative Profile Hash Calculation
- **Raw Input String**: `IBAN: DE89370400440532013000 / BIC: COBADEFFXXX`
- **Encoding**: UTF-8 bytes
- **Hashing Algorithm**: SHA-256 (`crypto.subtle.digest` in browser / Node `crypto.createHash('sha256')`)
- **Digest Output (Hex)**: `e0a9e37d5cb17ded767cf3b2c5a6b12b58403f1a92c909f8555f9c93e18d91e4`
- **Byte Length**: Exactly 32 bytes (64 hex characters)
- **Validation**: Verified in unit test suite `apps/web/src/lib/crypto.test.ts`.

---

## 3. Empirical Testnet Transaction: `create_escrow`

### Transaction Submission & Confirmation Proof

| Field | Ledger Value | Notes |
|---|---|---|
| **Transaction Hash** | `a32176a0b19236c1ad89a39d785c0cfa467b6674ef47fac4da45328c285a3ced` | Authoritative 64-char hex |
| **Ledger Sequence** | `5036360` | Onchain ledger |
| **Status** | `SUCCESS` | Confirmed via `getTransaction` RPC |
| **Public Explorer** | [`stellar.expert/explorer/testnet/tx/a32176a0b19236c1ad89a39d785c0cfa467b6674ef47fac4da45328c285a3ced`](https://stellar.expert/explorer/testnet/tx/a32176a0b19236c1ad89a39d785c0cfa467b6674ef47fac4da45328c285a3ced) | Live ledger record |
| **Invoker / Payer** | `GCPCLN3KACIKLP4WTH7R4P3FPO4LFM2XUZG3WH43YXOUFBTBK2ZCRJIC` | Funded Testnet account |
| **Contract Invoked** | `CD36A2JQEEQSBTKOE6T5PB3BPV7IGIYDSSOBOOK6NE4RSOWGNC2HXXDA` | Anchor Gate Escrow |
| **Function** | `create_escrow` | Canonical Soroban contract method |

### Invocation Arguments

| Argument Name | Type | Value |
|---|---|---|
| `payer` | `Address` | `GCPCLN3KACIKLP4WTH7R4P3FPO4LFM2XUZG3WH43YXOUFBTBK2ZCRJIC` |
| `beneficiary` | `Address` | `GCPCLN3KACIKLP4WTH7R4P3FPO4LFM2XUZG3WH43YXOUFBTBK2ZCRJIC` |
| `token` | `Address` | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| `amount` | `i128` | `10000000` (1.0000000 XLM) |
| `lock_duration` | `u64` | `604800` (7 days) |
| `profile_hash` | `BytesN<32>` | `e0a9e37d5cb17ded767cf3b2c5a6b12b58403f1a92c909f8555f9c93e18d91e4` |

### Emitted Contract Event Proof

The contract emitted an authoritative event recorded in ledger `5036360`:
- **Event ID**: `0021631001490927616-0000000001`
- **Contract**: `CD36A2JQEEQSBTKOE6T5PB3BPV7IGIYDSSOBOOK6NE4RSOWGNC2HXXDA`
- **Topics**:
  - `Symbol("created")`
  - `u64(3)` (Escrow ID: 3)
- **Data (Tuple/Struct)**: Contains payer, beneficiary, token, amount (`10000000`), lock duration (`604800`), and profile hash (`e0a9e37d5cb1...`).

---

## 4. Relay Event Decoding & Storage Verification

The Go relay service subscriber was tested against real XDR event structures:
- Decodes `topics`: `[Symbol("disbursed"), u64(escrow_id)]`
- Decodes `data`: `Tuple(BytesN<32>(profile_hash), i128(payout_amount))` into `*big.Int`
- Rejects corrupt or invalid payloads with explicit errors
- Persists events to durable disk store (`DurableFileStore`) across crashes and restarts
- Transitions events through explicit states: `observed` → `claimed` → `processing` → `completed` (or `failed`)
- Prevents premature acknowledgement before downstream execution finishes

Verified via Go test suite:
- `services/relay/internal/listener`: 11 unit tests passing (`go test -race ./internal/listener/...`)
- `services/relay/internal/store`: 4 unit tests passing (`go test -race ./internal/store/...`)

---

## 5. Verification Boundary & Classification

In accordance with strict audit honesty standards:

| Component / Layer | Status | Evidence / Verification Method |
|---|---|---|
| **Contract Deployment Parity** | **VERIFIED ONCHAIN** | Contract ID `CD36A2...` deployed and verified on Testnet |
| **Escrow Creation (`create_escrow`)** | **VERIFIED ONCHAIN** | Tx `a32176a0...` on ledger `5036360`, Escrow ID 3 |
| **Profile Hash Integrity** | **VERIFIED** | Real SHA-256 `e0a9e37d...` verified mathematically and in tests |
| **Relay Event XDR Decoding** | **VERIFIED IN TESTS** | Full XDR decoding tested with Go `-race` |
| **Relay Durable Storage & Idempotency** | **VERIFIED IN TESTS** | File-backed durable store crash recovery tested with Go `-race` |
| **Frontend Simulation & Polling Engine** | **VERIFIED IN TESTS** | Real Soroban RPC flow unit tested (`apps/web/src/lib/transaction.test.ts`) |
| **Frontend Live Wallet Boundary** | **UNVERIFIED (REQUIREMENT)** | Freighter extension interactive popup requires physical browser with extension installed. Mocking or faking this boundary is strictly prohibited. |

---

## 6. Toolchain Baseline

- **Node.js**: `v20.18.0` (Aligned with `@stellar/stellar-sdk` engine requirement `^20.18.0 || >=22.11.0`)
- **Go**: `go1.22.4 linux/amd64` (Aligned with `go.mod 1.22`)
- **Stellar SDK**: `@stellar/stellar-sdk@17.2.0` (Zero CVEs, upgraded from 13.x)
- **Next.js**: `16.0.7` / React `19.2.1`
