# Contributing to SorobanAnchor Gate App

Thank you for contributing to SorobanAnchor Gate! We welcome contributions that maintain code quality, test coverage, and clear architectural boundaries.

---

## Repository Structure & Branch Strategy

### Monorepo Structure
- **`apps/web`**: Next.js 16 Web Dashboard & Freighter Wallet Console.
- **`packages/contract-client`**: TypeScript SDK for contract parameter encoding & validation.
- **`services/relay`**: Go background daemon for Soroban RPC event polling.

### Branch Strategy
- **Default Branch**: `develop` is the primary integration branch for active development.
- **Release Branch**: `main` serves as the stable release branch for tagged releases.
- **Feature Branches**: Create feature branches off `develop`:
  - `feat/<feature-name>`
  - `fix/<bug-description>`
  - `docs/<doc-update>`
  - `chore/<task-name>`

All pull requests must target `develop`.

---

## Engineering Standards & Commit Hygiene

To keep the project history clear and auditable, please follow these guidelines:

### 1. One Logical Unit per Commit
Each commit should represent a single logical change. Related code, tests, and documentation belonging to that change should be committed together. Avoid bundling unrelated tasks.

> **Note**: One logical unit does not mean one file per commit. Stage all files that comprise the logical unit together.

### 2. Conventional Commits
Use standard conventional commit prefixes with an appropriate scope:
- `feat(web): add transaction confirmation dialog`
- `feat(sdk): add token formatting helper`
- `fix(relay): handle reconnection on rpc error`
- `test(web): verify wallet disconnection state`
- `docs(readme): clarify relay verification status`
- `chore(deps): update stellar sdk version`

### 3. Selective File Staging
- Stage specific files that belong to the logical unit: `git add <file1> <file2>`.
- Avoid blanket staging commands such as `git add .` or `git commit -a` to prevent unintentionally committing untracked files, local configuration, or sensitive tokens.
- Review staged changes with `git diff --staged` before committing.

### 4. Run Verification Before PR
Run the relevant test suites and linters locally before submitting your changes.

---

## Local Testing & Verification Commands

Before opening a pull request, ensure that all checks pass for the components you modified:

### 1. Next.js Web Dashboard (`apps/web`)
```bash
cd apps/web
npm install
npm run lint
npm run typecheck
npm run test
npm run build
```

### 2. TypeScript Contract Client (`packages/contract-client`)
```bash
cd packages/contract-client
npm install
npm run typecheck
npm run test
npm run build
```

### 3. Go Relay Daemon (`services/relay`)
```bash
cd services/relay
go vet ./...
go test -v -race ./...
go build ./cmd/relay/main.go
```

---

## Pull Request Guidelines

1. Ensure all relevant local tests pass.
2. Complete the pull request template with a clear summary and verification details.
3. Keep pull requests focused on a single topic or feature.
4. Update documentation if public APIs, environment variables, or behaviors change.

---

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
