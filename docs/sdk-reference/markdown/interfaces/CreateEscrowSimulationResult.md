[**Soroban Anchor Gate Contract Client SDK v0.1.0**](../README.md)

***

[Soroban Anchor Gate Contract Client SDK](../README.md) / CreateEscrowSimulationResult

# Interface: CreateEscrowSimulationResult

Defined in: simulation.ts:95

Fee and ledger information returned for a simulated `create_escrow` call.

## Properties

### estimatedResourceFeeStroops

> **estimatedResourceFeeStroops**: `bigint`

Defined in: simulation.ts:101

Soroban resource fee estimate, in stroops, from RPC `minResourceFee`.
This value is represented as bigint to preserve the RPC's integer
precision.

***

### estimatedRestoreResourceFeeStroops?

> `optional` **estimatedRestoreResourceFeeStroops?**: `bigint`

Defined in: simulation.ts:120

Resource fee estimate for the separate restoration transaction, in
stroops, when `requiresRestore` is true. This is not included in
`estimatedTransactionFeeStroops`.

***

### estimatedTransactionFeeStroops

> **estimatedTransactionFeeStroops**: `bigint`

Defined in: simulation.ts:107

Fee on the SDK-assembled unsigned transaction, in stroops. It includes
the resource estimate plus the inclusion fee supplied to the transaction
builder; network surge pricing may change the final amount.

***

### latestLedger?

> `optional` **latestLedger?**: `number`

Defined in: simulation.ts:112

Latest closed ledger known to the RPC server when it answered the
simulation. This is not a minimum ledger sequence or a validity bound.

***

### requiresRestore

> **requiresRestore**: `boolean`

Defined in: simulation.ts:114

Whether RPC reports that a separate ledger-entry restoration is needed.
