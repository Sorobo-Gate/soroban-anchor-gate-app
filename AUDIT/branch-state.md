# Branch State & Workflow Strategy Audit

## Current Observed Branch Topology

```
* a88048a (HEAD -> develop, origin/develop, origin/HEAD) docs(audit): upgrade Freighter boundary claims to verified onchain
* 86ca229 docs(evidence): record verified Freighter Testnet transaction
* 2e6ef3d Merge pull request #10 from Sorobo-Gate/dependabot/npm_and_yarn/apps/web/eslint-config-next-16.3.8
* 1b9d6d5 Merge pull request #8 from Sorobo-Gate/dependabot/npm_and_yarn/apps/web/types/node-26.6.4
* f938ae1 Merge pull request #6 from Sorobo-Gate/dependabot/npm_and_yarn/apps/web/stellar/stellar-sdk-17.2.1
* 8f559f6 build(deps): bump actions/setup-node from 4 to 7 (#5)
* 57baaac build(deps): bump actions/checkout from 4 to 7 (#4)
* f835541 build(deps): bump actions/setup-go from 5 to 7 (#3)
* db55649 docs(web): add environment template with contract CBIHLECK
* 9cc9bf3 build(web): allow tracking of .env.example template
* f6b85f7 ci(web): configure explicit contract ID for production build step
* fead70b docs(audit): update branch state audit with current develop commits
* 8239442 docs(readme): update testnet evidence references for contract CBIHLECK
... [70+ atomic commits documenting SDK parity, XDR decoding, durable file store, and CI fixes]
* a93c145 (origin/main) Create CONTRIBUTING.md
* 52bc731 Update README.md
* 65d02ce Initial commit
```

## Branch Strategy & Metrics Analysis

- **Default Remote Branch**: `develop` (`origin/HEAD` points to `origin/develop`).
- **Current develop HEAD**: `a88048ad86caa97e08c526b9f018309a0130da60`.
- **Relationship Between develop and main**: `develop` is currently **91 commits ahead** of `origin/main` (`a93c145`).
- **Main Branch**: `main` remains pinned at initial setup (`a93c145`) awaiting formal release promotion.
- **Continuous Integration (CI)**: **100% Green / Passing** across all three jobs:
  - `Go Relay Service Checks`
  - `TypeScript Contract Client SDK Checks`
  - `Next.js Web Frontend Checks`
- **Open Pull Requests**: **0 open PRs**.
- **Issue Tracking**:
  - **Issue #2** (`feat(web): build interactive escrow creation form with Freighter connect`): **Closed** (fully implemented, simulated, and verified onchain).
  - **Issue #1** (`feat(relay): implement SEP-10 challenge signer client`): **Open** (preserved honestly as planned future roadmap / known limitation).
- **GitHub Release Status**: **0 published releases** in `apps` repository (ready for `v0.1.0` promotion).

---

## Onchain Verification Baseline

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

## Release Readiness State

The application repository has passed all implementation, contract parity, test coverage, and live onchain verification milestones. It is **READY FOR MAIN PROMOTION** and tagging of the initial `v0.1.0` release. SEP-10 programmatic challenge authentication remains tracked in Issue #1 as a known future integration item.
