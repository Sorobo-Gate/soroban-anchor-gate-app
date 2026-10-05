# Branch State & Workflow Strategy Audit

## Current Observed Branch Topology

```
* 38e7286 (HEAD -> develop, origin/develop, origin/HEAD) feat(web): update brand identity, UI components, and documentation
* abcb104 ci: add GitHub Actions workflow for relay service
* 8b8ecbe docs: add security policy and audit status disclaimer
* 7a4cdd1 chore: scaffold application monorepo structure with relay service and contract client
* aaf7bbf Update: remove contract file
* 4c6adb3 build(frontend): update stellar-sdk and freighter-api dependencies
* 0590a65 chore: scaffold minimum viable monorepo for soroban-anchor-gate
* a93c145 (origin/main) Create CONTRIBUTING.md
* 52bc731 Update README.md
* 65d02ce Initial commit
```

## Branch Strategy Analysis

- **Default Remote Branch**: `develop` (`origin/HEAD` points to `origin/develop`).
- **Active Feature/Integration Branch**: `develop` is currently 7 commits ahead of `origin/main`.
- **Main Branch**: `main` is pinned at initial setup (`a93c145`).

## Relationship Between `develop` and `main`

`develop` contains the active monorepo structure (`apps/web`, `packages/contract-client`, `services/relay`). `main` acts as the stable release branch, while `develop` serves as the primary integration target for all active development.

## Action Plan & Governance

1. **Keep `develop` as Primary Target**: All ongoing feature development, fixes, and tests will target `develop`.
2. **Update CI Triggers**: GitHub Actions workflows in `.github/workflows/ci.yml` must target both `develop` and `main` so PRs and pushes to `develop` trigger automated checks.
3. **Release Promotion**: When `develop` reaches a verified, tested state with full contract parity and end-to-end Testnet validation, a PR will promote `develop` to `main` for release `v0.1.0`.
