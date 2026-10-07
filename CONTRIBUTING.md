# Contributing to SorobanAnchor Gate

Thank you for contributing to SorobanAnchor Gate! Please read the following guidelines before submitting pull requests.

---

## 📌 Repository Structure & Branch Strategy

### Monorepo Structure
- **`apps/web`**: Next.js 16 Web Dashboard & Freighter Wallet Console.
- **`packages/contract-client`**: TypeScript SDK for contract parameter encoding & validation.
- **`services/relay`**: Go background daemon for Soroban RPC event polling.

### Branch Strategy
- **Default Branch**: `develop` is the primary integration branch for all ongoing development.
- **Release Branch**: `main` serves as the stable production release branch.
- **Feature Branches**: Create feature branches off `develop` using standard naming conventions:
  - `feat/feature-name`
  - `fix/bug-description`
  - `docs/documentation-update`

---

## 🛠️ Internal Engineering Discipline

All code modifications MUST follow strict atomic commit discipline:

1. **Implement Single Logical Unit**
2. **Run Component Validation Tests**
3. **Inspect `git diff` & `git diff --check`**
4. **Selectively Stage Specific Files** (`git add <file1> <file2>`)
5. **Commit with Conventional Message**
6. **Push Immediately**

> ⚠️ **STRICT RULE**: `git add .` is strictly prohibited. Always stage specific files for your logical unit.

---

## 🧪 Local Testing & Verification Commands

Before opening a PR, ensure all monorepo checks pass cleanly:

### 1. TypeScript Contract Client
```bash
cd packages/contract-client
npm install
npm run typecheck
npm run test
npm run build
```

### 2. Go Relay Daemon
```bash
cd services/relay
go vet ./...
go test -v -race ./...
go build ./cmd/relay/main.go
```

### 3. Next.js Web Dashboard
```bash
cd apps/web
npm install
npm run lint
npm run typecheck
npm run build
```

---

## 📝 Conventional Commit Format

Commits must follow Conventional Commits specification:

- `feat(web): ...`
- `feat(sdk): ...`
- `feat(relay): ...`
- `fix(relay): ...`
- `docs(audit): ...`
- `ci: ...`

---

## 📄 License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
