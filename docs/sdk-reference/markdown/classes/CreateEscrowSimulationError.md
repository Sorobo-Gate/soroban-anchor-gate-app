[**Soroban Anchor Gate Contract Client SDK v0.1.0**](../README.md)

***

[Soroban Anchor Gate Contract Client SDK](../README.md) / CreateEscrowSimulationError

# Class: CreateEscrowSimulationError

Defined in: simulation.ts:56

A simulation failure with a stable category and, when recognized, a
machine-readable escrow contract error code.

## Extends

- `Error`

## Constructors

### Constructor

> **new CreateEscrowSimulationError**(`message`, `kind`, `details?`): `CreateEscrowSimulationError`

Defined in: simulation.ts:72

#### Parameters

##### message

`string`

##### kind

[`CreateEscrowSimulationErrorKind`](../type-aliases/CreateEscrowSimulationErrorKind.md)

##### details?

###### contractErrorCode?

`number`

###### contractErrorName?

`string`

###### rpcCode?

`string` \| `number`

###### rpcMessage?

`string`

#### Returns

`CreateEscrowSimulationError`

#### Overrides

`Error.constructor`

## Properties

### contractErrorCode?

> `readonly` `optional` **contractErrorCode?**: `number`

Defined in: simulation.ts:61

Contract error number from the Soroban host response, when present.

***

### contractErrorName?

> `readonly` `optional` **contractErrorName?**: `string`

Defined in: simulation.ts:64

Name mapped from the Anchor Gate contract's documented error enum.

***

### kind

> `readonly` **kind**: [`CreateEscrowSimulationErrorKind`](../type-aliases/CreateEscrowSimulationErrorKind.md)

Defined in: simulation.ts:58

Error category suitable for programmatic handling.

***

### rpcCode?

> `readonly` `optional` **rpcCode?**: `string` \| `number`

Defined in: simulation.ts:70

Structured JSON-RPC or transport code, when the SDK exposes one.

***

### rpcMessage?

> `readonly` `optional` **rpcMessage?**: `string`

Defined in: simulation.ts:67

Sanitized RPC or simulation message, when the server provided one.
