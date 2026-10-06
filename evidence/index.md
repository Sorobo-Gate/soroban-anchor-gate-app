# Verification & Evidence Index

This document maps all protocol claims and features to their empirical source code, automated test suites, CI checks, and Testnet transaction verification.

---

## Protocol Verification Status Matrix

| System / Feature | Verification Level | Source Files | Automated Test Suite | Empirical Evidence |
|---|---|---|---|---|
| **Contract Parity & Functions** | `VERIFIED ONCHAIN` | [`packages/contract-client/src/index.ts`](../packages/contract-client/src/index.ts) | `packages/contract-client/src/index.test.ts` (13/13 passed) | [`evidence/testnet-verified-2026-10-06.md`](./testnet-verified-2026-10-06.md) |
| **Escrow Creation Onchain** | `VERIFIED ONCHAIN` | [`apps/web/src/lib/transaction.ts`](../apps/web/src/lib/transaction.ts) | `apps/web/src/lib/transaction.test.ts` (21/21 passed) | [`evidence/testnet-verified-2026-10-06.md`](./testnet-verified-2026-10-06.md) (Tx `e0b57482...`) |
| **Client-Side SHA-256 Profile Hash** | `VERIFIED` | [`apps/web/src/lib/crypto.ts`](../apps/web/src/lib/crypto.ts) | `apps/web/src/lib/crypto.test.ts` (3/3 passed) | [`evidence/testnet-verified-2026-10-06.md`](./testnet-verified-2026-10-06.md) |
| **Integer-Safe Token Math** | `VERIFIED` | [`packages/contract-client/src/index.ts`](../packages/contract-client/src/index.ts) | `packages/contract-client/src/index.test.ts` | SDK test suite |
| **Soroban RPC Event Poller** | `TESTED LOCALLY` | [`services/relay/internal/listener/subscriber.go`](../services/relay/internal/listener/subscriber.go) | `go test -v -race ./internal/listener/...` (11/11 passed) | [`docs/relay.md`](../docs/relay.md) |
| **i128 Event Payout Decoding** | `TESTED LOCALLY` | [`services/relay/internal/listener/subscriber.go`](../services/relay/internal/listener/subscriber.go) | `subscriber_test.go` (`*big.Int`) | Go test suite |
| **Durable Store & Idempotency** | `TESTED LOCALLY` | [`services/relay/internal/store/idempotency.go`](../services/relay/internal/store/idempotency.go) | `idempotency_test.go` (4/4 passed) | Go test suite |
| **Monorepo CI Workflows** | `VERIFIED` | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | GitHub Actions CI (Passing) | CI workflow definitions |
| **Non-Custodial Freighter Extension Boundary** | `UNVERIFIED` | [`apps/web/src/app/page.tsx`](../apps/web/src/app/page.tsx) | Typecheck & Build Clean | Requires interactive physical browser with extension |
| **SEP-10 / SEP-31 Off-Ramp Gateway** | `KNOWN LIMITATION` | N/A | N/A | Documented limitation |

---

## Historical & Verification Records

- [`evidence/testnet-verified-2026-10-06.md`](./testnet-verified-2026-10-06.md): Authoritative empirical Testnet report for redeployed contract `CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT`.
- [`evidence/testnet-verified-2026-10-05.md`](./testnet-verified-2026-10-05.md): Historical verification record for prior deployment `CD36A2...` (ledger `5036360`).
- [`evidence/testnet-2026-10-05.md`](./testnet-2026-10-05.md): Historical report reclassified as **INVALID EVIDENCE / AUDIT NOTICE** due to synthetic addresses and empty string hash.

---

## Status Classification Key
- **`VERIFIED ONCHAIN`**: Live Stellar Testnet transaction executed, confirmed on ledger, and explorer link documented.
- **`VERIFIED`**: Full end-to-end implementation validated via automated test suite and cryptographic proofs.
- **`TESTED LOCALLY`**: Implementation validated locally with 100% passing unit and race condition test suite.
- **`LOGICALLY COVERED`**: Feature logic implemented and typechecked; awaiting live partner testnet anchors.
- **`UNVERIFIED`**: Boundary requiring interactive physical user/extension presence; simulation strictly avoided.
- **`KNOWN LIMITATION`**: Functional limitation explicitly documented in public documentation.
- **`BLOCKED`**: Upstream external dependency missing or inaccessible.
