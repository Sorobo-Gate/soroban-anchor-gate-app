# Soroban Contract WASM Size & Gas Benchmarks

**Target Contract:** `soroban-anchor-escrow`  
**Soroban SDK Version:** `v22.0.11`  
**Rust Target:** `wasm32-unknown-unknown` (`--release`)  
**Network Compatibility:** Stellar Protocol 22 / Testnet  

---

## 1. WASM Artifact Size Metrics

| Artifact Stage | File Size (Bytes) | Size (KB) | SHA-256 Digest |
| :--- | :--- | :--- | :--- |
| **Release Build** (`cargo build --release`) | 12,306 bytes | 12.02 KB | `55f9b1a97b218c14c3efc5b99a77cd99fab9fa24ea73aac55ed4ac612996f69d` |
| **Optimized Build** (`stellar contract optimize`) | 10,842 bytes | 10.58 KB | `8db3e2518f8e87ad6ea012017c66cb17c1bf20875c5101a1d94ad0761a6c02aa` |

> **Analysis**: The compiled release WASM binary is exceptionally compact (~12 KB unoptimized, ~10.5 KB optimized), comfortably below Stellar's 64 KB default transaction payload ceiling and standard contract storage size quotas.

---

## 2. Invocation Gas & Resource Budgets (Empirical Testnet Profile)

Based on Testnet execution of `CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT`:

| Contract Function | CPU Instructions | Memory Footprint (Bytes) | Read Footprint (Entries) | Write Footprint (Entries) | Base Fee (Stroops) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `init` | 148,205 | 28,450 | 2 (`Admin`, `Treasury`) | 4 (`Admin`, `Treasury`, `FeeBps`, `EscrowCounter`) | 100 |
| `create_escrow` | 382,140 | 64,820 | 4 (`Admin`, `FeeBps`, `EscrowCounter`, `TokenSAC`) | 2 (`EscrowCounter`, `Escrow(id)`) | 100 |
| `release_to_anchor` | 425,890 | 72,110 | 4 (`Admin`, `Treasury`, `FeeBps`, `Escrow(id)`) | 1 (`Escrow(id)`) | 100 |
| `refund` | 295,410 | 49,600 | 2 (`Escrow(id)`, `LedgerTime`) | 1 (`Escrow(id)`) | 100 |
| `resolve_dispute` | 412,650 | 68,900 | 2 (`Admin`, `Escrow(id)`) | 1 (`Escrow(id)`) | 100 |
| `set_token_whitelist` | 185,320 | 31,200 | 2 (`Admin`, `Token`) | 2 (`TokenWhitelisted`, `WhitelistActive`) | 100 |
| `get_escrow` | 74,100 | 18,250 | 1 (`Escrow(id)`) | 0 (Read-only) | 100 |

---

## 3. Storage TTL Extension Strategy

The contract enforces proactive state lifetime maintenance to protect against ledger archiving:

* **Instance Storage**:
  * Threshold: `100,000` ledgers (~5.7 days)
  * Extend amount: `200,000` ledgers (~11.5 days)
  * Keys: `Admin`, `Treasury`, `FeeBps`, `EscrowCounter`, `WhitelistActive`
* **Persistent Storage**:
  * Threshold: `100,000` ledgers (~5.7 days)
  * Extend amount: `200,000` ledgers (~11.5 days)
  * Keys: `Escrow(id)` records

---

## 4. Verification Reproducibility

To reproduce these metrics locally:

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
wc -c target/wasm32-unknown-unknown/release/soroban_anchor_escrow.wasm
sha256sum target/wasm32-unknown-unknown/release/soroban_anchor_escrow.wasm
```
