[**Soroban Anchor Gate Contract Client SDK v0.1.0**](../README.md)

***

[Soroban Anchor Gate Contract Client SDK](../README.md) / simulateCreateEscrow

# Function: simulateCreateEscrow()

> **simulateCreateEscrow**(`params`, `options?`): `Promise`\<[`CreateEscrowSimulationResult`](../interfaces/CreateEscrowSimulationResult.md)\>

Defined in: simulation.ts:463

Simulates the escrow contract's `create_escrow` invocation and estimates
fees without signing or submitting a transaction.

`params` contains the existing escrow creation fields plus a `config`
property with `contractId`, `rpcUrl`, and `networkPassphrase`. The payer
account is fetched from Soroban RPC to obtain its current transaction
sequence; it is used as the transaction source so the RPC can record the
payer's contract authorization without private keys.

The result reports resource fees in integer stroops as `bigint`. Its
`latestLedger` is the server's latest closed ledger at simulation time. SDK
v17.2.1 does not expose a minimum ledger sequence in a simulation response,
so this helper does not invent one. Simulations are estimates and do not
guarantee transaction inclusion or successful execution later.

## Parameters

### params

[`CreateEscrowParams`](../interfaces/CreateEscrowParams.md)

Escrow arguments and the client configuration.

### options?

[`SimulateCreateEscrowOptions`](../interfaces/SimulateCreateEscrowOptions.md) = `{}`

Optional RPC server injection or request timeout.

## Returns

`Promise`\<[`CreateEscrowSimulationResult`](../interfaces/CreateEscrowSimulationResult.md)\>

Estimated resource fees, the SDK-assembled transaction fee, and
  ledger/restoration information.

## Example

```ts
const estimate = await simulateCreateEscrow({
  config: { contractId, rpcUrl, networkPassphrase },
  payer,
  beneficiary,
  token,
  amount: 1_000_000n,
  profileHashHex,
  lockDurationSeconds: 86_400n,
});
console.log(estimate.estimatedResourceFeeStroops.toString());
```

## Throws

If inputs are invalid, RPC fails,
  simulation rejects the invocation, or the RPC response is malformed.
