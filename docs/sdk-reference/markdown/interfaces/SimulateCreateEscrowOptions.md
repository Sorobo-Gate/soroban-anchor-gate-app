[**Soroban Anchor Gate Contract Client SDK v0.1.0**](../README.md)

***

[Soroban Anchor Gate Contract Client SDK](../README.md) / SimulateCreateEscrowOptions

# Interface: SimulateCreateEscrowOptions

Defined in: simulation.ts:31

Options for customizing the RPC transport used by [simulateCreateEscrow](../functions/simulateCreateEscrow.md).

## Properties

### server?

> `optional` **server?**: `Pick`\<`RpcServer`, `"getAccount"` \| `"simulateTransaction"`\>

Defined in: simulation.ts:37

RPC implementation, primarily useful for tests or custom transports.
It is only used to fetch the payer account and simulate the transaction;
it is never asked to sign or submit it.

***

### timeoutMs?

> `optional` **timeoutMs?**: `number`

Defined in: simulation.ts:42

Optional RPC request timeout in milliseconds. The Stellar SDK defaults to
no timeout when this is omitted.
