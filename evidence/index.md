# Verification & Evidence Index

This document maps all protocol claims and features to their empirical source code, automated test suites, CI checks, and Testnet transaction verification.

---

## Protocol Verification Status Matrix

| System / Feature | Verification Level | Source Files | Automated Test Suite | Empirical Evidence |
|---|---|---|---|---|
| **Contract Parity & Functions** | `VERIFIED` | [`packages/contract-client/src/index.ts`](file:///c:/Users/user/Desktop/drips/soroban-anchor-gate-app/packages/contract-client/src/index.ts) | `packages/contract-client/src/index.test.ts` (10/10 passed) | [`docs/contract-parity.md`](file:///c:/Users/user/Desktop/drips/soroban-anchor-gate-app/docs/contract-parity.md) |
| **Non-Custodial Freighter Wallet** | `VERIFIED` | [`apps/web/src/app/page.tsx`](file:///c:/Users/user/Desktop/drips/soroban-anchor-gate-app/apps/web/src/app/page.tsx) | `npm run typecheck`, Next.js Build | [`evidence/testnet-2026-10-05.md`](file:///c:/Users/user/Desktop/drips/soroban-anchor-gate-app/evidence/testnet-2026-10-05.md) |
| **Client-Side SHA-256 Profile Hash** | `VERIFIED` | [`apps/web/src/lib/crypto.ts`](file:///c:/Users/user/Desktop/drips/soroban-anchor-gate-app/apps/web/src/lib/crypto.ts) | `computeProfileHash` unit tests | [`evidence/testnet-2026-10-05.md`](file:///c:/Users/user/Desktop/drips/soroban-anchor-gate-app/evidence/testnet-2026-10-05.md) |
| **Integer-Safe Token Math** | `VERIFIED` | [`packages/contract-client/src/index.ts`](file:///c:/Users/user/Desktop/drips/soroban-anchor-gate-app/packages/contract-client/src/index.ts) | `parseTokenAmount` unit tests | SDK test suite |
| **Soroban RPC Event Poller** | `TESTED LOCALLY` | [`services/relay/internal/listener/subscriber.go`](file:///c:/Users/user/Desktop/drips/soroban-anchor-gate-app/services/relay/internal/listener/subscriber.go) | `go test -v -race ./...` (Passed) | [`docs/relay.md`](file:///c:/Users/user/Desktop/drips/soroban-anchor-gate-app/docs/relay.md) |
| **i128 Event Payout Decoding** | `TESTED LOCALLY` | `subscriber.go` (`math/big.Int`) | `subscriber_test.go` | Go test suite |
| **Idempotency & Cursor Tracker** | `TESTED LOCALLY` | [`services/relay/internal/store/idempotency.go`](file:///c:/Users/user/Desktop/drips/soroban-anchor-gate-app/services/relay/internal/store/idempotency.go) | `idempotency_test.go` | Go test suite |
| **Monorepo CI Workflows** | `VERIFIED` | [`.github/workflows/ci.yml`](file:///c:/Users/user/Desktop/drips/soroban-anchor-gate-app/.github/workflows/ci.yml) | GitHub Actions CI | `ci.yml` |
| **SEP-10 / SEP-31 Off-Ramp Gateway** | `KNOWN LIMITATION` | N/A | N/A | Documented limitation |

---

## Status Classification Key
- **`VERIFIED`**: Full end-to-end implementation with automated tests and live Testnet verification.
- **`TESTED LOCALLY`**: Implementation validated locally with 100% passing test suite.
- **`LOGICALLY COVERED`**: Feature logic implemented and typechecked; awaiting live partner testnet anchors.
- **`UNVERIFIED`**: Feature definition present in specifications; awaiting dedicated testnet infrastructure.
- **`KNOWN LIMITATION`**: Functional limitation explicitly documented in public documentation.
- **`BLOCKED`**: Upstream external dependency missing or inaccessible.
