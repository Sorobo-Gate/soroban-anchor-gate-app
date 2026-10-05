# Known Limitations & Audit Disclaimers

## Implementation Status Classification

| Boundary / System | Status | Description |
|---|---|---|
| **Soroban Smart Contract Client** | `VERIFIED` | Full TypeScript SDK for `init`, `create_escrow`, `release_to_anchor`, and `refund` invocations with 13/13 passing unit tests |
| **Escrow Creation Onchain** | `VERIFIED ONCHAIN` | Live Stellar Testnet transaction (`a32176a0...`) confirmed on ledger `5036360` with real profile hash |
| **Freighter Wallet Extension Boundary** | `UNVERIFIED (EXTENSION BOUNDARY)` | Real Freighter connection, network check, and signature building; requires physical browser with extension installed |
| **Soroban Event Listening & Durable Store** | `TESTED LOCALLY` | Go relay daemon with RPC event poller, real XDR `disbursed` decoder, durable file store, and 15/15 tests passing with `-race` |
| **SEP-1 Anchor Discovery** | `UNVERIFIED` | Standard `stellar.toml` discovery endpoints require active anchor hosting |
| **SEP-10 Web Authentication** | `PLANNED` | Challenge-response authentication workflow planned for off-ramp anchor gateways |
| **SEP-12 / SEP-31 Payout Rail** | `KNOWN LIMITATION` | Full live banking payout execution requires integrated anchor partner credentials |

## Audit Status

This codebase is under active open-source development and has not undergone a formal third-party cryptographic security audit. Do not deploy to Stellar Mainnet with real capital without independent verification.
