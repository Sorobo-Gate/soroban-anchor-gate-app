[**Soroban Anchor Gate Contract Client SDK v0.1.0**](../README.md)

***

[Soroban Anchor Gate Contract Client SDK](../README.md) / CreateEscrowParams

# Interface: CreateEscrowParams

Defined in: simulation.ts:25

Parameters for simulating `create_escrow`.

This adds the RPC and network configuration needed by the free simulation
helper to the existing [EscrowCreateParams](EscrowCreateParams.md) contract.

## Extends

- [`EscrowCreateParams`](EscrowCreateParams.md)

## Properties

### amount

> **amount**: `bigint`

Defined in: [index.ts:48](https://github.com/akinyemi07/soroban-anchor-gate-app/blob/90f09824d012b4b8fb273e081d4938a21836c703/packages/contract-client/src/index.ts#L48)

Amount in the token's smallest unit (stroops for seven-decimal tokens).

#### Inherited from

[`EscrowCreateParams`](EscrowCreateParams.md).[`amount`](EscrowCreateParams.md#amount)

***

### beneficiary

> **beneficiary**: `string`

Defined in: [index.ts:44](https://github.com/akinyemi07/soroban-anchor-gate-app/blob/90f09824d012b4b8fb273e081d4938a21836c703/packages/contract-client/src/index.ts#L44)

Stellar account that can receive the escrowed funds.

#### Inherited from

[`EscrowCreateParams`](EscrowCreateParams.md).[`beneficiary`](EscrowCreateParams.md#beneficiary)

***

### config

> **config**: [`ClientConfig`](ClientConfig.md)

Defined in: simulation.ts:27

Contract ID, Soroban RPC endpoint, and network passphrase.

***

### lockDurationSeconds

> **lockDurationSeconds**: `bigint`

Defined in: [index.ts:52](https://github.com/akinyemi07/soroban-anchor-gate-app/blob/90f09824d012b4b8fb273e081d4938a21836c703/packages/contract-client/src/index.ts#L52)

Number of seconds the funds remain locked before refunds are allowed.

#### Inherited from

[`EscrowCreateParams`](EscrowCreateParams.md).[`lockDurationSeconds`](EscrowCreateParams.md#lockdurationseconds)

***

### payer

> **payer**: `string`

Defined in: [index.ts:42](https://github.com/akinyemi07/soroban-anchor-gate-app/blob/90f09824d012b4b8fb273e081d4938a21836c703/packages/contract-client/src/index.ts#L42)

Stellar account funding and owning the escrow.

#### Inherited from

[`EscrowCreateParams`](EscrowCreateParams.md).[`payer`](EscrowCreateParams.md#payer)

***

### profileHashHex

> **profileHashHex**: `string`

Defined in: [index.ts:50](https://github.com/akinyemi07/soroban-anchor-gate-app/blob/90f09824d012b4b8fb273e081d4938a21836c703/packages/contract-client/src/index.ts#L50)

SHA-256 hash of the beneficiary routing profile, as 64 hexadecimal characters.

#### Inherited from

[`EscrowCreateParams`](EscrowCreateParams.md).[`profileHashHex`](EscrowCreateParams.md#profilehashhex)

***

### token

> **token**: `string`

Defined in: [index.ts:46](https://github.com/akinyemi07/soroban-anchor-gate-app/blob/90f09824d012b4b8fb273e081d4938a21836c703/packages/contract-client/src/index.ts#L46)

Token contract address used for the escrow amount.

#### Inherited from

[`EscrowCreateParams`](EscrowCreateParams.md).[`token`](EscrowCreateParams.md#token)
