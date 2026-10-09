# Branch State & Workflow Strategy Audit

**Audit Date:** 2026-10-09
**Repository:** `Sorobo-Gate/soroban-anchor-gate-app`
**Current HEAD:** `8a8394a7de8916b5a6249b1e9ed536e2617c299e` on branch `develop`
**Default Branch (Remote):** `develop`
**Release Branch:** `main` (at `8a8394a7de8916b5a6249b1e9ed536e2617c299e`)
**Public Release Tag:** `v0.1.0` (commit `8a8394a7de8916b5a6249b1e9ed536e2617c299e`, release `v0.1.0`)

---

## 1. Observed Branch Condition & Alignment

Inspection via Git CLI and GitHub API confirms the following branch topology:

- **Branch Alignment**: `main` and `develop` are **identical** (`8a8394a7de8916b5a6249b1e9ed536e2617c299e`). `develop` is 0 commits ahead and 0 commits behind `origin/main`.
- **Default Remote Branch**: `develop` (`origin/HEAD` points to `origin/develop`).
- **Release Promotion**: Release promotion to `main` is complete. Both branches point to the same verified release commit.
- **Branch Protection & Enforcement**:
  - **Status**: **Active & Verified on both `main` and `develop`**.
  - **develop Rules**: Required status checks (`Go Relay Service Checks`, `TypeScript Contract Client SDK Checks`, `Next.js Web Frontend Checks`); minimum 1 approving review required; stale reviews dismissed on new push; force pushes disabled; branch deletions disabled; administrative override permitted for maintainer emergency maintenance (`enforce_admins: false`).
  - **main Rules**: Protected release branch; force pushes disabled; branch deletions disabled (`enforce_admins: false`).
- **Continuous Integration (CI)**: **Passing** across all workflows on both `main` and `develop`:
  - `Go Relay Service Checks`
  - `TypeScript Contract Client SDK Checks`
  - `Next.js Web Frontend Checks`
  - Latest App & Services CI on `main` passes.
- **GitHub Release Status**: Release [`v0.1.0`](https://github.com/Sorobo-Gate/soroban-anchor-gate-app/releases/tag/v0.1.0) ("SorobanAnchor Gate App v0.1.0") is published with target `main` (commit `8a8394a7de8916b5a6249b1e9ed536e2617c299e`).
- **Issues & PR Status**:
  - Open PRs: **0**.
  - Open Issues: **1**:
    - `#1` `feat(relay): implement SEP-10 challenge signer client` (preserved honestly as legitimate planned future integration work / known boundary).
  - Closed Issues:
    - `#2` `feat(web): build interactive escrow creation form with Freighter connect` (closed; fully implemented and verified onchain).

---

## 2. Onchain Verification Baseline

- **Verified Contract ID**: `CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT` (matching `soroban-anchor-gate-contract` release `v0.1.1`).
- **Interactive Browser Wallet Verification**:
  - **Provider**: Freighter Browser Extension (`@stellar/freighter-api@6.0.1`).
  - **Transaction Hash**: [`2392ac9b4de86ac22c6d3b5d10fe12c387e8c9a7ea04217763a2defcf0015e42`](https://stellar.expert/explorer/testnet/tx/2392ac9b4de86ac22c6d3b5d10fe12c387e8c9a7ea04217763a2defcf0015e42).
  - **Ledger Sequence**: `5069983`.
  - **Signer Public Key**: `GCHIAK3LLDWJ5N4Z4TH6GHCH2LQX5SUL2WEU42I324CFXGDUWXMNNSDZ`.
  - **Contract Function**: `create_escrow` (Escrow #3 created with 32-byte SHA-256 profile commitment).
  - **Final RPC Status**: `SUCCESS`.
  - **Evidence File**: [`evidence/testnet-verified-2026-10-07.md`](../evidence/testnet-verified-2026-10-07.md).

---

## 3. Release & Branch Lifecycle Summary

Release promotion is complete. The application repository and companion services are fully aligned between `develop` and `main` at `v0.1.0`. All required CI checks on `main` pass. SEP-10 programmatic challenge authentication remains tracked in Issue #1 as legitimate future integration work. The app is not waiting for release; release promotion is finished and verified.

---

## 4. Historical State Reference

For auditing and traceability purposes, previous milestone states are catalogued:
- **Pre-Promotion Integration HEAD**: Commit `a88048ad` previously served as develop HEAD prior to release promotion PR #13 / #14.
- **Initial Setup Baseline**: Commit `a93c145` ("Create CONTRIBUTING.md") previously anchored initial repository scaffolding before release promotion aligned `main` with `develop`.
