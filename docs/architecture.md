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
    participant Store as Durable File Store

    User->>FE: Enter beneficiary, amount, & bank routing info
    FE->>SDK: Compute 32-byte SHA-256 profile_hash & parse amount
    SDK-->>FE: Return profile_hash & ScVal invocation parameters
    FE->>RPC: simulateTransaction(builtTx)
    RPC-->>FE: Return simulation results, resource footprint & auth
    FE->>FE: assembleTransaction(builtTx, simResponse)
    FE->>Wallet: Request transaction signature via signTransaction(envelopeXdr)
    Wallet-->>FE: Return signed Transaction Envelope XDR
    FE->>RPC: sendTransaction(signedEnvelopeXdr)
    RPC-->>FE: Return txHash & initial pending status
    loop Authoritative Confirmation Polling
        FE->>RPC: getTransaction(txHash)
        RPC-->>FE: Return status (PENDING / SUCCESS / FAILED)
    end
    RPC->>Contract: Execute create_escrow()
    Contract-->>Contract: Emit "created" Soroban event

    Note over Contract,Relay: Later: release_to_anchor() emits "disbursed"
    loop Event Listener Polling
        Relay->>RPC: getEvents(startLedger, contractId, topic="disbursed")
        RPC-->>Relay: Return contract events
        Relay->>Store: Claim event_id (claim status)
        alt Event New & Claimed
            Relay->>Store: Set state = processing
            Relay->>Relay: Process disbursement & notify off-ramp gateway
            Relay->>Store: Set state = completed & advance cursor
        else Duplicate or Already Processed
            Relay->>Store: Skip duplicate event
        end
    end
```

## Component Boundaries

1. **Frontend (`apps/web`)**: Client-side Next.js 16 application providing wallet connection, profile hashing, fee calculation, simulation, signing, and authoritative `getTransaction` confirmation polling.
2. **Contract Client (`packages/contract-client`)**: TypeScript SDK containing integer-safe math helpers (`parseTokenAmount`, `formatTokenAmount`), profile hash computation, and typed Soroban invocation builders (`init`, `create_escrow`, `release_to_anchor`, `refund`).
3. **Go Relay Daemon (`services/relay`)**: Long-running background daemon polling Soroban RPC for `disbursed` events, enforcing crash-resilient state transitions (`observed` → `claimed` → `processing` → `completed`), tracking ledger cursor via `DurableFileStore`, and triggering anchor off-ramp execution.
