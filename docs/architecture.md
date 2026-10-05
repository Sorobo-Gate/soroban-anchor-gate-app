# SorobanAnchor Gate Architecture

## System Overview

SorobanAnchor Gate provides a smart-contract-backed milestone escrow and anchor off-ramp gate on the Stellar network.

```mermaid
sequenceDiagram
    autonumber
    actor User as User / Depositor
    participant FE as Web Dashboard (apps/web)
    participant SDK as Contract Client SDK (packages/contract-client)
    participant Wallet as Freighter Extension
    participant RPC as Stellar Soroban RPC
    participant Contract as EscrowGate Contract (Soroban)
    participant Relay as Go Relay Daemon (services/relay)
    participant Store as Idempotency & Cursor Store

    User->>FE: Enter beneficiary, amount, & bank routing info
    FE->>SDK: Compute 32-byte SHA-256 profile_hash & parse amount
    SDK-->>FE: Return profile_hash & ScVal invocation parameters
    FE->>Wallet: Request transaction signature via signTransaction()
    Wallet-->>FE: Return signed Transaction Envelope XDR
    FE->>RPC: sendTransaction(signedTxXdr)
    RPC->>Contract: Execute create_escrow()
    Contract-->>Contract: Emit "disbursed" Soroban event

    loop Event Listener Polling
        Relay->>RPC: getEvents(startLedger, contractId, topic="disbursed")
        RPC-->>Relay: Return contract events
        Relay->>Store: Check event_id idempotency
        alt Event Not Processed
            Relay->>Store: Mark event_id processed & advance cursor
            Relay->>Relay: Process disbursement & notify off-ramp gateway
        else Duplicate Event
            Relay->>Store: Skip duplicate event
        end
    end
```

## Component Boundaries

1. **Frontend (`apps/web`)**: Client-side Next.js 16 application providing wallet connection, profile hashing, fee calculation, and transaction review.
2. **Contract Client (`packages/contract-client`)**: TypeScript SDK containing integer-safe math helpers (`parseTokenAmount`, `formatTokenAmount`), profile hash computation, and typed Soroban invocation builders.
3. **Go Relay Daemon (`services/relay`)**: Long-running background daemon polling Soroban RPC for `disbursed` events, enforcing idempotency, tracking ledger cursor, and triggering anchor off-ramp execution.
