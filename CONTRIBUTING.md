# Contributing to SorobanAnchor Gate

Thank you for contributing to SorobanAnchor Gate! We welcome contributions that maintain code quality, test coverage, and clear architectural boundaries across smart contracts, web applications, SDKs, and off-chain daemons.

---

## 🌊 Stellar Drips Wave Program Contributors

If you are participating through the **Stellar Drips Wave Program**, please review the following sprint guidelines:

### 1. Finding & Claiming Tasks
- Active Wave tasks are tracked under repository issues with the `drips-wave` label.
- Tasks are categorized by complexity and point rewards:
  - **`wave:trivial` (100 pts)**: Documentation fixes, typo corrections, minor tests, simple UI tweaks.
  - **`wave:medium` (150 pts)**: Concrete feature additions, bug fixes, SDK enhancements, integration tests.
  - **`wave:high` (200 pts)**: Complex protocol logic, arbiter resolution, cryptography, performance optimization.
- Comment on the issue to request assignment before beginning work to prevent duplicate effort.

### 2. Branching & Pull Requests
- Branch from `develop`:
  ```bash
  git checkout develop
  git pull origin develop
  git checkout -b wave/<issue-number>-<short-description>
  ```
- **PR Title**: Follow conventional commits (e.g., `feat(contracts): implement multi-token whitelist storage (#12)`).
- **PR Description**: Reference the issue (e.g., `Closes #12`) and include empirical evidence of your tests passing (terminal output or screenshots).
- All PRs must target the `develop` branch.

---

## Repository Architecture

```text
soroban-anchor-gate/
├── contracts/               # Soroban smart contract (Rust + Soroban SDK v22)
├── apps/
│   └── web/                 # Next.js 16 Web Dashboard & Freighter Wallet Interface
├── packages/
│   └── contract-client/     # TypeScript SDK for contract parameter encoding & validation
├── services/
│   └── relay/               # Go event listener daemon & durable event store
├── deployment/              # Docker Compose configuration and deployment manifests
├── install.sh               # One-click bootstrap script for all dependencies
└── package.json             # Root monorepo orchestrator
```

---

## One-Click Setup

To configure all dependencies, targets, and environment templates automatically:

```bash
./install.sh
```

Or run using npm / make:
```bash
npm run install:all
# or
make install
```

---

## Local Development & Testing

### Running the Stack
```bash
# Start Web UI (http://localhost:3000) and Go Relay daemon concurrently:
npm run dev

# Or with Docker:
docker compose up --build
```

### Running All Automated Tests
```bash
# Runs contract tests, SDK tests, web tests, and Go relay race tests:
npm test
# or
make test
```

### Component-Specific Verification

#### 1. Smart Contracts (`contracts/`)
```bash
cd contracts
make test              # Run 21 Soroban unit & lifecycle tests
make build             # Compile contract WASM artifact
make lint              # Run cargo fmt and clippy checks
```

#### 2. Next.js Web Dashboard (`apps/web/`)
```bash
cd apps/web
npm run lint           # ESLint verification
npm run typecheck      # TypeScript typecheck
npm run test           # Run 21 Jest/Node test cases
npm run build          # Production Next.js build
```

#### 3. Contract Client SDK (`packages/contract-client/`)
```bash
cd packages/contract-client
npm run typecheck      # Typecheck
npm run test           # Run 13 SDK unit tests
npm run build          # Build TypeScript distribution
```

#### 4. Go Relay Daemon (`services/relay/`)
```bash
cd services/relay
go vet ./...           # Static analysis
go test -v -race ./... # Concurrency race tests
go build ./cmd/relay/main.go
```

---

## Engineering Standards & Commit Hygiene

1. **One Logical Unit per Commit**: Each commit should represent a single logical change. Commit related code, tests, and documentation together.
2. **Conventional Commits**:
   - `feat(contracts): add arbiter dispute settlement`
   - `feat(web): add wallet connection status indicator`
   - `fix(relay): prevent replay of confirmed events`
   - `test(contracts): add unauthorized refund rejection test`
   - `docs(readme): update quickstart instructions`
3. **Selective Staging**: Stage specific files (`git add <file1> <file2>`). Avoid `git add .` to protect sensitive local configs.
4. **Mandatory Tests**: Every new feature or bug fix must include corresponding automated unit or integration tests.

---

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
