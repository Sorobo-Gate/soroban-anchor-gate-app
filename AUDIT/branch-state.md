# Branch State & Workflow Strategy Audit

## Current Observed Branch Topology

```
* 4671d6a (HEAD -> develop, origin/develop, origin/HEAD) docs(relay): update configuration parameters with contract ID and durable store
* 3f3c6a8 docs: align deployment configuration with verified contract ID and durable store
* b34fb0a docs: update cross repo parity matrix with contract ID and method signatures
* 1989966 docs: align contract parity spec with init signature and event tuple format
* e80d617 docs(audit): update readme claims audit with contract parity and durable store
* 0168259 docs(audit): document single file commit enforcement and linear history
* ab3d061 docs: update README with durable store details and verified testnet references
* 10d8990 docs(evidence): update verification index and correct path references
* 7cbef2f docs(evidence): record verified testnet transaction and real profile hash
* 669d894 docs(evidence): mark synthetic testnet artifact invalid
... [36 single-file remediation commits]
* 745d95e build(sdk): add lockfile for contract client package
... [historical commits]
* a93c145 (origin/main) Create CONTRIBUTING.md
* 52bc731 Update README.md
* 65d02ce Initial commit
```

## Branch Strategy Analysis

- **Default Remote Branch**: `develop` (`origin/HEAD` points to `origin/develop`).
- **Active Feature/Integration Branch**: `develop` is currently 54 commits ahead of `origin/main`.
- **Main Branch**: `main` remains pinned at initial setup (`a93c145`).
- **Merge Commits**: Exactly 0 merge commits across the entire branch history (`git rev-list --min-parents=2 HEAD` returns empty).
- **Linearity**: The branch history is strictly linear.

## Relationship Between `develop` and `main`

`develop` contains the active monorepo structure (`apps/web`, `packages/contract-client`, `services/relay`). `main` represents the stable release target, while `develop` serves as the primary integration and development branch.

## Action Plan & Governance

1. **Keep `develop` as Primary Development Target**: All ongoing feature development, fixes, single-file remediation commits, and tests target `develop`.
2. **CI Triggers**: GitHub Actions workflows in `.github/workflows/ci.yml` target both `develop` and `main`, running the Go Relay, TypeScript SDK, and Next.js Web Frontend test suites on pushes and PRs.
3. **Release Promotion to `main`**: With full contract parity, zero test failures, real Testnet validation on ledger `5036360`, and clean CI checks, promotion from `develop` to `main` can proceed via fast-forward or squash-free linear PR when authorized for release `v0.1.0`.
