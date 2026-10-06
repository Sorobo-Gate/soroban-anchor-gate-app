# Branch State & Workflow Strategy Audit

## Current Observed Branch Topology

```
* 8239442 (HEAD -> develop, origin/develop, origin/HEAD) docs(readme): update testnet evidence references for contract CBIHLECK
* 6fb5fe9 docs(evidence): annotate testnet-verified-2026-10-05 report as historical CD36A2 deployment
* 4af324a docs(evidence): update verification index with 2026-10-06 report reference
* 8137cf2 docs(evidence): document verified testnet evidence for contract CBIHLECK
* 0b6ae60 docs(audit): document subsequent commit batching analysis and safety constraints
* f01da21 docs(audit): update deployed contract claim to CBIHLECK
* e700072 docs(parity): update contract address to CBIHLECK in parity matrix
* 6f92b1b docs(relay): update contract ID to CBIHLECK in relay documentation
* 0234d08 docs(deployment): update deployment coordinates for contract CBIHLECK
* 69ec200 test(relay): align subscriber tests with contract CBIHLECK
* 95c9574 feat(relay): update default contract ID to CBIHLECK in daemon
* 1888c3e test(web): align transaction tests with contract CBIHLECK
* 314f07e test(web): verify production configuration enforcement
* 0b2d7a4 feat(web): update default contract ID to CBIHLECK and enforce in production
* 7464d76 test(sdk): update test contract ID to verified deployment CBIHLECK
* 02c2b06 build(web): update lockfile for source-map-js 1.2.2
* 84d6768 fix(deps): bump source-map-js to 1.2.2 in web dependencies
* 1daea66 ci: remove invalid gofmt ecosystem from dependabot config
... [40+ single-file atomic remediation commits]
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
