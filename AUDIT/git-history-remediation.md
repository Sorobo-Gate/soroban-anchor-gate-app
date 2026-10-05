# Git History Remediation & Batching Audit

## Historical Commit Analysis

Inspection of git log revealed historical commit batching across multiple components:

### 1. Commit `0590a656` (`chore: scaffold minimum viable monorepo for soroban-anchor-gate`)
- **What Changed**: Initial monorepo scaffolding including contract definitions, frontend scaffolding, backend relay code, and environment configurations.
- **Independent Logical Units**: Frontend base setup, contract Rust source, Go relay listener, package manifests, and root docs.
- **Remote / Shared Status**: Published to `origin/develop`.

### 2. Commit `7a4cdd15` (`chore: scaffold application monorepo structure with relay service and contract client`)
- **What Changed**: Monorepo layout reorganization (`apps/web`, `packages/contract-client`, `services/relay`), tsconfig updates, and relay subscriber updates.
- **Independent Logical Units**: Repository restructuring, contract-client SDK package creation, relay Go module setup.
- **Remote / Shared Status**: Published to `origin/develop`.

### 3. Commit `38e72868` (`feat(web): update brand identity, UI components, and documentation`)
- **What Changed**: Brand assets, UI primitive components (Button, Card, Input), dashboard redesign, global CSS, dependency lockfiles, and README update.
- **Independent Logical Units**: Brand logo asset, UI primitives, page dashboard logic, lockfile update, documentation rewrite.
- **Remote / Shared Status**: Published to `origin/develop`.

## History Preservation & Remediation Decision

- **Safety Check**: Commits `0590a656`, `7a4cdd15`, and `38e72868` have been pushed to `origin/develop`, which is the public default branch of `Sorobo-Gate/soroban-anchor-gate-app`.
- **Decision**: **PRESERVE HISTORY**. Force-pushing to rewrite published commits on `origin/develop` is destructive for collaborators and downstream clones.
- **Future Discipline Enforced**: Moving forward, all commits must be atomic and represent exactly ONE logical unit.
  - Implement unit → Test → Diff → Selectively Stage (`git add <specific-files>`) → Commit → Push immediately.
  - `git add .` is strictly prohibited.
