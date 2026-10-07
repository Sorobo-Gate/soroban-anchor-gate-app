# Security Policy & Vulnerability Disclosure

## 1. Non-Custodial Wallet Model

- **Zero Secret-Key Custody**: Neither the web dashboard (`apps/web`) nor the contract client SDK (`packages/contract-client`) requests, stores, or transmits user private keys (`S...`).
- **Client-Side Wallet Signing**: All transaction signatures are requested interactively through browser extension wallet providers (such as Freighter) via `@stellar/freighter-api`.

## 2. Secrets & Environment Variables

- **Environment Isolation**: Private environment variables (such as relay daemon credentials or admin keys) must never be prefixed with `NEXT_PUBLIC_*` or bundled into client-side web assets.
- **Relay Secret Safeguards**: Relay secrets should be supplied through a secure runtime secret store or deployment environment and must never be committed to the repository.

## 3. PII & Privacy Boundary

- **Onchain PII Protection**: Raw PII (bank accounts, IBANs, phone numbers, or identity documents) is never written to the Stellar ledger.
- **SHA-256 Commitments**: Sensitive banking parameters are deterministically hashed into 32-byte `profile_hash` commitments on the client prior to transaction construction.

## 4. Audit & Verification Status

- **Formal Audit Disclaimer**: This project has **not** undergone a third-party smart contract or application security audit. It is deployed exclusively to Stellar Testnet for testing and review.
- **Local Testing**: Automated test suites cover contract client encoding (13 tests), web UI state logic (21 tests), and Go relay decoding with race detection (15 tests).
- **Onchain Verification**: Testnet interactions and Freighter wallet signing are documented with transaction hashes in the `evidence/` directory.

## 5. Reporting a Vulnerability

If you discover a potential security vulnerability within this repository or associated components:

1. **Do NOT open a public GitHub issue.**
2. Report the vulnerability directly to the project maintainers via GitHub Security Advisories at [`https://github.com/Sorobo-Gate/soroban-anchor-gate-app/security/advisories/new`](https://github.com/Sorobo-Gate/soroban-anchor-gate-app/security/advisories/new).
3. Alternatively, contact maintainers directly at `emintechsolutions@gmail.com`.
4. Include detailed steps to reproduce, impact assessment, and any proposed remediations.

All legitimate security reports will be acknowledged promptly and investigated.
