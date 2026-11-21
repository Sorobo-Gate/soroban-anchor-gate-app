**Soroban Anchor Gate Contract Client SDK v0.1.0**

***

# Soroban Anchor Gate Contract Client SDK v0.1.0

Type-safe client helpers for the Soroban Anchor Gate escrow contract.

The module builds contract invocation arguments and operations, validates
client configuration and user input, parses contract results into ergonomic
TypeScript values, and simulates create-escrow invocations for fee estimates.
It also re-exports the TTL inspector, SEP-38 quote helpers, and exact token
unit conversion utilities that make up the public SDK surface.

## Enumerations

- [EscrowContractState](enumerations/EscrowContractState.md)
- [EscrowError](enumerations/EscrowError.md)

## Classes

- [CreateEscrowSimulationError](classes/CreateEscrowSimulationError.md)
- [EscrowGateClient](classes/EscrowGateClient.md)

## Interfaces

- [AnchorQuoteRequestOptions](interfaces/AnchorQuoteRequestOptions.md)
- [ClientConfig](interfaces/ClientConfig.md)
- [CreateEscrowParams](interfaces/CreateEscrowParams.md)
- [CreateEscrowSimulationResult](interfaces/CreateEscrowSimulationResult.md)
- [EscrowCreateParams](interfaces/EscrowCreateParams.md)
- [EscrowRecordView](interfaces/EscrowRecordView.md)
- [ReleaseToAnchorParams](interfaces/ReleaseToAnchorParams.md)
- [ResolveDisputeParams](interfaces/ResolveDisputeParams.md)
- [Sep38Fee](interfaces/Sep38Fee.md)
- [Sep38FeeDetail](interfaces/Sep38FeeDetail.md)
- [Sep38Quote](interfaces/Sep38Quote.md)
- [SetTokenWhitelistParams](interfaces/SetTokenWhitelistParams.md)
- [SimulateCreateEscrowOptions](interfaces/SimulateCreateEscrowOptions.md)
- [TTLInfo](interfaces/TTLInfo.md)
- [TTLInspectorOptions](interfaces/TTLInspectorOptions.md)

## Type Aliases

- [CreateEscrowSimulationErrorKind](type-aliases/CreateEscrowSimulationErrorKind.md)
- [Sep38QuoteContext](type-aliases/Sep38QuoteContext.md)

## Variables

- [DEFAULT\_BUMP\_THRESHOLD\_LEDGERS](variables/DEFAULT_BUMP_THRESHOLD_LEDGERS.md)
- [DEFAULT\_TOKEN\_DECIMALS](variables/DEFAULT_TOKEN_DECIMALS.md)
- [LEDGERS\_PER\_DAY](variables/LEDGERS_PER_DAY.md)
- [MAX\_TOKEN\_DECIMALS](variables/MAX_TOKEN_DECIMALS.md)
- [SECONDS\_PER\_LEDGER](variables/SECONDS_PER_LEDGER.md)

## Functions

- [buildEscrowLedgerKey](functions/buildEscrowLedgerKey.md)
- [computeProfileHash](functions/computeProfileHash.md)
- [discoverAnchorQuoteServer](functions/discoverAnchorQuoteServer.md)
- [formatTokenAmount](functions/formatTokenAmount.md)
- [fromStroops](functions/fromStroops.md)
- [getAnchorExchangeQuote](functions/getAnchorExchangeQuote.md)
- [inspectEscrowTTL](functions/inspectEscrowTTL.md)
- [isValidAddress](functions/isValidAddress.md)
- [parseAnchorQuoteServerFromToml](functions/parseAnchorQuoteServerFromToml.md)
- [parseTokenAmount](functions/parseTokenAmount.md)
- [simulateCreateEscrow](functions/simulateCreateEscrow.md)
- [toStroops](functions/toStroops.md)
- [validateClientConfig](functions/validateClientConfig.md)
- [validateProfileHashHex](functions/validateProfileHashHex.md)
