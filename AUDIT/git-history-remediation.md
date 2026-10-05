# Git History Remediation & Batching Audit

## Executive Summary

During the Second Deep Remediation of `Sorobo-Gate/soroban-anchor-gate-app`, the repository's git commit structure was audited. Prior historical commits exhibited batching across multiple components and directories. In accordance with audit standards, all remediation work has strictly adhered to single-file atomic commits with zero merge commits, maintaining a linear history.

---

## 1. Historical Commit Batching Analysis

Inspection of git log revealed historical commit batching across multiple components:

### Commit `0590a656` (`chore: scaffold minimum viable monorepo for soroban-anchor-gate`)
- **What Changed**: Initial monorepo scaffolding including contract definitions, frontend scaffolding, backend relay code, and environment configurations.
- **Independent Logical Units**: Frontend base setup, contract Rust source, Go relay listener, package manifests, and root docs.
- **Remote / Shared Status**: Published to `origin/develop`.

### Commit `7a4cdd15` (`chore: scaffold application monorepo structure with relay service and contract client`)
- **What Changed**: Monorepo layout reorganization (`apps/web`, `packages/contract-client`, `services/relay`), tsconfig updates, and relay subscriber updates.
- **Independent Logical Units**: Repository restructuring, contract-client SDK package creation, relay Go module setup.
- **Remote / Shared Status**: Published to `origin/develop`.

### Commit `38e72868` (`feat(web): update brand identity, UI components, and documentation`)
- **What Changed**: Brand assets, UI primitive components (Button, Card, Input), dashboard redesign, global CSS, dependency lockfiles, and README update.
- **Independent Logical Units**: Brand logo asset, UI primitives, page dashboard logic, lockfile update, documentation rewrite.
- **Remote / Shared Status**: Published to `origin/develop`.

---

## 2. History Preservation & Safety Decision

- **Safety Check**: Commits `0590a656`, `7a4cdd15`, and `38e72868` are part of the published default branch history on `origin/develop`.
- **Destructive Rewrite Risk**: Force-pushing to rewrite published history on `origin/develop` would break downstream contributor forks, invalidate GitHub action run references, and risk repository corruption.
- **Decision**: **PRESERVE HISTORICAL COMMITS** and enforce strict **SINGLE-FILE ATOMIC COMMITS** for all remediation and ongoing development.
- **Merge Commit Status**: Confirmed zero merge commits in remediation history (`git rev-list --min-parents=2 HEAD` returns empty).

---

## 3. Second Deep Remediation Commit Trail (Single File Commits)

Every remediation commit executed during this audit was performed strictly on a **single file per commit** basis:

1. `fb5baac` — `style(relay): apply gofmt to subscriber` (`services/relay/internal/listener/subscriber.go`)
2. `45a541f` — `fix(web): resolve frontend lint errors` (`apps/web/src/app/page.tsx`)
3. `2dc257b` — `ci(node): use supported runtime for stellar sdk` (`.github/workflows/ci.yml`)
4. `ba9c6c0` — `ci(node): use reproducible npm installs` (`.github/workflows/ci.yml`)
5. `910dada` — `ci(go): configure module cache path` (`.github/workflows/ci.yml`)
6. `fad3687` — `fix(sdk): align init builder with contract signature` (`packages/contract-client/src/index.ts`)
7. `5ac8f26` — `test(sdk): cover contract argument encoding and parity` (`packages/contract-client/src/index.test.ts`)
8. `d78d1a3` — `chore(sdk): upgrade stellar-sdk to 17.2.0` (`packages/contract-client/package.json`)
9. `63dd97d` — `build(sdk): update lockfile for stellar-sdk 17.2.0` (`packages/contract-client/package-lock.json`)
10. `5b5e729` — `feat(relay): add durable idempotency and cursor store` (`services/relay/internal/store/idempotency.go`)
11. `ab688c6` — `test(relay): cover durable store states and restart recovery` (`services/relay/internal/store/idempotency_test.go`)
12. `6865da1` — `feat(relay): decode disbursed event XDR` (`services/relay/internal/listener/subscriber.go`)
13. `6e853ef` — `test(relay): cover disbursed XDR decoding` (`services/relay/internal/listener/subscriber_test.go`)
14. `ef2a167` — `feat(relay): wire durable store and contract ID in daemon` (`services/relay/cmd/relay/main.go`)
15. `3d516ca` — `chore(relay): align go module version with Go 1.22 baseline` (`services/relay/go.mod`)
16. `a9909ab` — `fix(web): type children prop in root layout` (`apps/web/src/app/layout.tsx`)
17. `389ee5f` — `feat(web): add application configuration validation` (`apps/web/src/lib/config.ts`)
18. `6680f05` — `feat(web): implement authoritative Soroban transaction flow` (`apps/web/src/lib/transaction.ts`)
19. `dfe0134` — `test(web): cover transaction validation, simulation, and polling` (`apps/web/src/lib/transaction.test.ts`)
20. `c9e767c` — `test(web): cover application configuration validation` (`apps/web/src/lib/config.test.ts`)
21. `2c232b9` — `test(web): cover SHA-256 profile hashing and integer conversion` (`apps/web/src/lib/crypto.test.ts`)
22. `2adbaf0` — `feat(web): wire real transaction construction and confirmation polling` (`apps/web/src/app/page.tsx`)
23. `1423fe5` — `chore(web): add test script and tsx runner` (`apps/web/package.json`)
24. `85ffd83` — `build(web): update lockfile for tsx test runner` (`apps/web/package-lock.json`)
25. `8957247` — `build(web): set target to ES2022 for bigint literals` (`apps/web/tsconfig.json`)
26. `76721e4` — `ci(web): run frontend unit test suite in CI` (`.github/workflows/ci.yml`)
27. `669d894` — `docs(evidence): mark synthetic testnet artifact invalid` (`evidence/testnet-2026-10-05.md`)
28. `7cbef2f` — `docs(evidence): record verified testnet transaction and real profile hash` (`evidence/testnet-verified-2026-10-05.md`)
29. `10d8990` — `docs(evidence): update verification index and correct path references` (`evidence/index.md`)
30. `ab3d061` — `docs: update README with durable store details and verified testnet references` (`README.md`)

---

## 4. Verification Check Commands

To verify the git history guarantees at any time:

```bash
# Verify no merge commits exist on develop
git rev-list --min-parents=2 HEAD

# Verify linear history
git log --oneline --graph -n 35
```
