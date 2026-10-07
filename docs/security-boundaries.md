# Security Boundaries & Custody Model

## 1. Non-Custodial Architecture

- **No Secret Keys Stored**: Neither the web dashboard (`apps/web`) nor the TypeScript SDK (`packages/contract-client`) requests, stores, or transmits user secret keys (`S...`).
- **Wallet Signing Model**: All transaction signing occurs strictly inside the user's browser extension (Freighter wallet) via standard `@stellar/freighter-api` calls (`requestAccess`, `signTransaction`).
- **Relay Signer Key Isolation**: Any secret keys used by the background relay daemon for administrative or payout authorization are loaded via environment variables and never exposed to public web bundles (`NEXT_PUBLIC_*`).

## 2. Onchain Privacy Model

- **No Raw PII Onchain**: Bank account numbers, IBANs, phone numbers, and KYC details are never placed in plaintext on the Stellar ledger.
- **32-Byte Profile Hash**: Sensitive banking coordinates are hashed on the client using SHA-256 into a 32-byte digest (`profile_hash`). The smart contract stores only this 32-byte commitment.

## 3. Network & Configuration Boundaries

- **Passphrase Verification**: The application verifies that the active wallet network matches the configured Stellar Testnet passphrase (`Test SDF Network ; September 2015`).
- **Numeric Overflow Protection**: Token amounts are handled as integer base units using JavaScript `bigint` and Go `math/big.Int` to prevent IEEE 754 floating-point rounding errors or 64-bit integer truncation.
