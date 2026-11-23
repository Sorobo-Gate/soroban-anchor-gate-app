/**
 * Type-safe client helpers for the Soroban Anchor Gate escrow contract.
 *
 * The module builds contract invocation arguments and operations, validates
 * client configuration and user input, and parses contract results into
 * ergonomic TypeScript values. It also re-exports the TTL inspector, SEP-38
 * quote helpers, and exact token unit conversion utilities that make up the
 * public SDK surface.
 *
 * @packageDocumentation
 */

import {
  Address,
  Contract,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { createHash } from "crypto";

/**
 * Connection and network settings required by {@link EscrowGateClient}.
 */
export interface ClientConfig {
  /** Soroban contract ID encoded as a Stellar `C...` contract address. */
  contractId: string;
  /** Soroban RPC endpoint used to simulate and submit transactions. */
  rpcUrl: string;
  /** Stellar network passphrase, for example `Test SDF Network ; September 2015`. */
  networkPassphrase: string;
}

/**
 * Arguments for creating a new escrow through `create_escrow`.
 */
export interface EscrowCreateParams {
  /** Stellar account funding and owning the escrow. */
  payer: string;
  /** Stellar account that can receive the escrowed funds. */
  beneficiary: string;
  /** Token contract address used for the escrow amount. */
  token: string;
  /** Amount in the token's smallest unit (stroops for seven-decimal tokens). */
  amount: bigint;
  /** SHA-256 hash of the beneficiary routing profile, as 64 hexadecimal characters. */
  profileHashHex: string;
  /** Number of seconds the funds remain locked before refunds are allowed. */
  lockDurationSeconds: bigint;
}

/**
 * Arguments for releasing an escrowed payment to an anchor disbursement
 * address through `release_to_anchor`.
 */
export interface ReleaseToAnchorParams {
  /** Identifier of the escrow to release. */
  escrowId: bigint;
  /** Stellar account authorized to invoke the release. */
  caller: string;
  /** Anchor-controlled Stellar account that receives the funds. */
  anchorDisbursementAddress: string;
}

/**
 * On-chain escrow lifecycle states returned by `get_escrow`.
 */
export enum EscrowContractState {
  /** Funds are locked and awaiting release or refund. */
  Funded = "Funded",
  /** Funds were released to the anchor. */
  Disbursed = "Disbursed",
  /** Funds were returned to the payer. */
  Refunded = "Refunded",
  /** The escrow is subject to an active dispute. */
  Disputed = "Disputed",
}

/**
 * Numeric error codes emitted by the escrow contract.
 *
 * The values match the contract's `Error` enum and can be compared against
 * diagnostic events or simulation failures.
 */
export enum EscrowError {
  /** The contract has not been initialized. */
  NotInitialized = 1,
  /** The contract was already initialized. */
  AlreadyInitialized = 2,
  /** The caller is not authorized for the requested operation. */
  Unauthorized = 3,
  /** No escrow exists for the supplied identifier. */
  EscrowNotFound = 4,
  /** The escrow is not in a state that permits the operation. */
  InvalidStatus = 5,
  /** The unlock timestamp has not been reached yet. */
  UnlockTimeNotReached = 6,
  /** The unlock timestamp has already passed. */
  UnlockTimePassed = 7,
  /** The supplied amount is zero. */
  ZeroAmount = 8,
  /** Basis points are invalid or do not sum to 10,000. */
  InvalidBps = 9,
  /** An arithmetic operation overflowed. */
  ArithmeticOverflow = 10,
  /** The token is not on the contract whitelist. */
  TokenNotWhitelisted = 11,
  /** The dispute split is invalid. */
  InvalidDisputeSplit = 12,
}

/**
 * Arguments for resolving a disputed escrow through `resolve_dispute`.
 */
export interface ResolveDisputeParams {
  /** Identifier of the escrow to resolve. */
  escrowId: bigint;
  /** Stellar account authorized to resolve the dispute. */
  caller: string;
  /** Share awarded to the payer, in basis points out of 10,000. */
  payerBps: number;
  /** Share awarded to the beneficiary, in basis points out of 10,000. */
  beneficiaryBps: number;
}

/**
 * Arguments for updating the token whitelist through `set_token_whitelist`.
 */
export interface SetTokenWhitelistParams {
  /** Stellar account authorized to update the whitelist. */
  caller: string;
  /** Token contract address to update. */
  token: string;
  /** Whether the token should be allowed for escrow creation. */
  whitelisted: boolean;
}

/**
 * Decoded view of an escrow record returned by `get_escrow`.
 */
export interface EscrowRecordView {
  /** Stellar account that funded the escrow. */
  payer: string;
  /** Stellar account that can receive the escrowed funds. */
  beneficiary: string;
  /** Token contract address used for the escrow amount. */
  token: string;
  /** Escrowed amount in the token's smallest unit. */
  amount: bigint;
  /** SHA-256 hash of the beneficiary routing profile, as hexadecimal. */
  profileHashHex: string;
  /** Current lifecycle state of the escrow. */
  status: EscrowContractState;
  /** Unix timestamp, in seconds, when the escrow becomes refundable. */
  unlockTimestamp: bigint;
}

/**
 * Validates the connection settings for an {@link EscrowGateClient}.
 *
 * @param config - Client configuration to validate.
 * @throws {Error} If the contract ID, RPC URL, or network passphrase is
 *   missing or malformed.
 *
 * @example
 * ```ts
 * validateClientConfig({
 *   contractId: "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT",
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 *   networkPassphrase: "Test SDF Network ; September 2015",
 * });
 * ```
 */
export function validateClientConfig(config: ClientConfig): void {
  if (!config.contractId || !StrKey.isValidContract(config.contractId)) {
    throw new Error(`Invalid contract ID format: ${config.contractId}`);
  }
  if (!config.rpcUrl || !config.rpcUrl.startsWith("http")) {
    throw new Error(`Invalid RPC URL: ${config.rpcUrl}`);
  }
  if (!config.networkPassphrase || config.networkPassphrase.trim() === "") {
    throw new Error("Network passphrase cannot be empty");
  }
}

/**
 * Checks whether a string is a valid Stellar account or contract address.
 *
 * @param address - Candidate `G...` account or `C...` contract address.
 * @returns `true` when the address has a valid StrKey encoding.
 */
export function isValidAddress(address: string): boolean {
  return (
    StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address)
  );
}

/**
 * Computes the SHA-256 hash used to store a beneficiary routing profile
 * on-chain.
 *
 * Leading and trailing whitespace is ignored so equivalent profiles produce
 * the same hash. The returned value is lowercase hexadecimal and is always 64
 * characters long.
 *
 * @param routingInfo - Raw routing information, such as an IBAN or bank
 *   account reference.
 * @returns Lowercase SHA-256 hash as hexadecimal.
 * @throws {Error} If `routingInfo` is empty or contains only whitespace.
 */
export function computeProfileHash(routingInfo: string): string {
  if (!routingInfo || routingInfo.trim() === "") {
    throw new Error("Routing information cannot be empty");
  }
  return createHash("sha256").update(routingInfo.trim()).digest("hex");
}

/**
 * Validates that a profile hash is exactly 32 bytes of hexadecimal text.
 *
 * @param hashHex - Candidate SHA-256 hash.
 * @throws {Error} If the value is not 64 hexadecimal characters.
 */
export function validateProfileHashHex(hashHex: string): void {
  const hexRegex = /^[0-9a-fA-F]{64}$/;
  if (!hexRegex.test(hashHex)) {
    throw new Error("profileHash must be exactly 32 bytes (64 hex characters)");
  }
}

/**
 * Converts a human-readable token amount to its integer representation.
 *
 * This helper is kept for backwards compatibility. New code should prefer
 * {@link toStroops}, which supports exact decimal exponents and reports
 * sub-stroop precision explicitly.
 *
 * @param amountStr - Non-negative decimal amount string.
 * @param decimals - Number of decimal places used by the token. Defaults to `7`.
 * @returns The amount scaled by `10^decimals`.
 * @throws {Error} If the amount is empty, negative, non-numeric, or has more
 *   fractional digits than `decimals`.
 */
export function parseTokenAmount(
  amountStr: string,
  decimals: number = 7
): bigint {
  if (!amountStr || isNaN(Number(amountStr)) || Number(amountStr) < 0) {
    throw new Error(`Invalid token amount string: ${amountStr}`);
  }
  const parts = amountStr.trim().split(".");
  const integerPart = parts[0] || "0";
  let fractionalPart = parts[1] || "";

  if (fractionalPart.length > decimals) {
    throw new Error(`Amount exceeds maximum supported decimals (${decimals})`);
  }

  fractionalPart = fractionalPart.padEnd(decimals, "0");
  const fullStr = integerPart + fractionalPart;
  return BigInt(fullStr);
}

/**
 * Converts an integer token amount to a human-readable decimal string.
 *
 * This helper is kept for backwards compatibility. New code should prefer
 * {@link fromStroops}, which validates the amount type at runtime.
 *
 * @param amount - Non-negative scaled integer amount.
 * @param decimals - Number of decimal places used by the token. Defaults to `7`.
 * @returns Decimal string with trailing fractional zeroes removed.
 * @throws {Error} If `amount` is negative.
 */
export function formatTokenAmount(
  amount: bigint,
  decimals: number = 7
): string {
  if (amount < 0n) {
    throw new Error("Token amount cannot be negative");
  }
  const str = amount.toString().padStart(decimals + 1, "0");
  const integerPart = str.slice(0, str.length - decimals);
  const fractionalPart = str.slice(str.length - decimals).replace(/0+$/, "");
  return fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;
}

/**
 * Client for building Soroban invocations targeting the Anchor Gate escrow
 * contract.
 *
 * The client is stateless and does not submit transactions. It validates
 * inputs, encodes contract arguments with the Stellar SDK, and returns
 * operations that callers can add to a `TransactionBuilder`, simulate, sign,
 * and submit through their preferred RPC or wallet flow.
 *
 * @example
 * ```ts
 * const client = new EscrowGateClient({
 *   contractId: "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT",
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 *   networkPassphrase: "Test SDF Network ; September 2015",
 * });
 *
 * const operation = client.buildOperation(
 *   "get_escrow",
 *   client.buildGetEscrowTx(1n)
 * );
 * ```
 */
export class EscrowGateClient {
  /** Stellar SDK contract wrapper bound to {@link ClientConfig.contractId}. */
  public readonly contract: Contract;

  /**
   * Creates a client and validates the supplied configuration.
   *
   * @param config - Contract ID, RPC URL, and network passphrase.
   * @throws {Error} If the configuration is invalid.
   */
  constructor(public readonly config: ClientConfig) {
    validateClientConfig(config);
    this.contract = new Contract(config.contractId);
  }

  /**
   * Builds arguments for the contract's `init` method.
   *
   * @param admin - Stellar account that will administer the contract.
   * @param treasury - Stellar account that receives protocol fees.
   * @param feeBps - Protocol fee in basis points, from `0` to `1000`.
   * @returns ScVal arguments in contract call order.
   * @throws {Error} If an address is invalid or `feeBps` is out of range or
   *   not an integer.
   */
  public buildInitTx(
    admin: string,
    treasury: string,
    feeBps: number
  ): xdr.ScVal[] {
    if (!isValidAddress(admin) || !isValidAddress(treasury)) {
      throw new Error("Invalid admin or treasury address");
    }
    if (feeBps < 0 || feeBps > 1000 || !Number.isInteger(feeBps)) {
      throw new Error("feeBps must be an integer between 0 and 1000 (inclusive)");
    }
    return [
      new Address(admin).toScVal(),
      new Address(treasury).toScVal(),
      nativeToScVal(feeBps, { type: "u32" }),
    ];
  }

  /**
   * Builds arguments for the contract's `create_escrow` method.
   *
   * @param params - Payer, beneficiary, token, amount, profile hash, and lock
   *   duration for the new escrow.
   * @returns ScVal arguments in contract call order.
   * @throws {Error} If an address is invalid, the amount or lock duration is
   *   not positive, or the profile hash is malformed.
   */
  public buildCreateEscrowTx(params: EscrowCreateParams): xdr.ScVal[] {
    if (!isValidAddress(params.payer)) {
      throw new Error(`Invalid payer address: ${params.payer}`);
    }
    if (!isValidAddress(params.beneficiary)) {
      throw new Error(`Invalid beneficiary address: ${params.beneficiary}`);
    }
    if (!isValidAddress(params.token)) {
      throw new Error(`Invalid token address: ${params.token}`);
    }
    if (params.amount <= 0n) {
      throw new Error("Amount must be greater than zero");
    }
    validateProfileHashHex(params.profileHashHex);
    if (params.lockDurationSeconds <= 0n) {
      throw new Error("Lock duration must be greater than zero");
    }

    const hashBytes = Buffer.from(params.profileHashHex, "hex");

    return [
      new Address(params.payer).toScVal(),
      new Address(params.beneficiary).toScVal(),
      new Address(params.token).toScVal(),
      nativeToScVal(params.amount, { type: "i128" }),
      xdr.ScVal.scvBytes(hashBytes),
      nativeToScVal(params.lockDurationSeconds, { type: "u64" }),
    ];
  }

  /**
   * Builds arguments for the contract's `release_to_anchor` method.
   *
   * @param params - Escrow identifier, authorized caller, and anchor
   *   disbursement address.
   * @returns ScVal arguments in contract call order.
   * @throws {Error} If the caller or disbursement address is invalid.
   */
  public buildReleaseToAnchorTx(
    params: ReleaseToAnchorParams
  ): xdr.ScVal[] {
    if (!isValidAddress(params.caller)) {
      throw new Error(`Invalid caller address: ${params.caller}`);
    }
    if (!isValidAddress(params.anchorDisbursementAddress)) {
      throw new Error(
        `Invalid anchor disbursement address: ${params.anchorDisbursementAddress}`
      );
    }
    return [
      nativeToScVal(params.escrowId, { type: "u64" }),
      new Address(params.caller).toScVal(),
      new Address(params.anchorDisbursementAddress).toScVal(),
    ];
  }

  /**
   * Builds arguments for the contract's `refund` method.
   *
   * @param escrowId - Identifier of the escrow to refund.
   * @returns ScVal arguments containing the escrow ID.
   * @throws {Error} If `escrowId` is negative.
   */
  public buildRefundTx(escrowId: bigint): xdr.ScVal[] {
    if (escrowId < 0n) {
      throw new Error("escrowId cannot be negative");
    }
    return [nativeToScVal(escrowId, { type: "u64" })];
  }

  /**
   * Builds arguments for the contract's `resolve_dispute` method.
   *
   * @param params - Escrow identifier, authorized caller, and payer and
   *   beneficiary shares in basis points.
   * @returns ScVal arguments in contract call order.
   * @throws {Error} If the escrow ID is negative, the caller is invalid, or the
   *   split is negative or does not sum to exactly 10,000 basis points.
   */
  public buildResolveDisputeTx(params: ResolveDisputeParams): xdr.ScVal[] {
    if (params.escrowId < 0n) {
      throw new Error("escrowId cannot be negative");
    }
    if (!isValidAddress(params.caller)) {
      throw new Error(`Invalid caller address: ${params.caller}`);
    }
    if (
      params.payerBps < 0 ||
      params.beneficiaryBps < 0 ||
      params.payerBps + params.beneficiaryBps !== 10000
    ) {
      throw new Error(
        "Dispute split basis points must sum to exactly 10,000 (100%)"
      );
    }
    return [
      nativeToScVal(params.escrowId, { type: "u64" }),
      new Address(params.caller).toScVal(),
      nativeToScVal(params.payerBps, { type: "u32" }),
      nativeToScVal(params.beneficiaryBps, { type: "u32" }),
    ];
  }

  /**
   * Builds arguments for the contract's `set_token_whitelist` method.
   *
   * @param params - Caller, token address, and new whitelist status.
   * @returns ScVal arguments in contract call order.
   * @throws {Error} If the caller or token address is invalid.
   */
  public buildSetTokenWhitelistTx(
    params: SetTokenWhitelistParams
  ): xdr.ScVal[] {
    if (!isValidAddress(params.caller)) {
      throw new Error(`Invalid caller address: ${params.caller}`);
    }
    if (!isValidAddress(params.token)) {
      throw new Error(`Invalid token address: ${params.token}`);
    }
    return [
      new Address(params.caller).toScVal(),
      new Address(params.token).toScVal(),
      nativeToScVal(params.whitelisted, { type: "bool" }),
    ];
  }

  /**
   * Builds arguments for the contract's `get_escrow` query.
   *
   * @param escrowId - Identifier of the escrow to read.
   * @returns ScVal arguments containing the escrow ID.
   * @throws {Error} If `escrowId` is negative.
   */
  public buildGetEscrowTx(escrowId: bigint): xdr.ScVal[] {
    if (escrowId < 0n) {
      throw new Error("escrowId cannot be negative");
    }
    return [nativeToScVal(escrowId, { type: "u64" })];
  }

  /**
   * Builds arguments for the contract's `is_token_whitelisted` query.
   *
   * @param token - Token contract address to check.
   * @returns ScVal arguments containing the token address.
   * @throws {Error} If `token` is not a valid Stellar address.
   */
  public buildIsTokenWhitelistedTx(token: string): xdr.ScVal[] {
    if (!isValidAddress(token)) {
      throw new Error(`Invalid token address: ${token}`);
    }
    return [new Address(token).toScVal()];
  }

  /**
   * Creates a Soroban contract invocation operation for a supported method.
   *
   * @param method - Contract method name to invoke.
   * @param args - ScVal arguments produced by one of the `build*Tx` helpers.
   * @returns An operation ready to be added to a `TransactionBuilder`.
   */
  public buildOperation(
    method:
      | "init"
      | "create_escrow"
      | "release_to_anchor"
      | "refund"
      | "resolve_dispute"
      | "set_token_whitelist"
      | "is_token_whitelisted"
      | "get_escrow"
      | "get_counter"
      | "get_admin"
      | "get_treasury"
      | "get_fee_bps",
    args: xdr.ScVal[]
  ): xdr.Operation {
    return this.contract.call(method, ...args);
  }

  /**
   * Parses a raw `get_escrow` response into an {@link EscrowRecordView}.
   *
   * @param rawVal - ScVal returned by the contract.
   * @returns Decoded escrow record with addresses, amount, hash, status, and
   *   unlock timestamp.
   * @throws {Error} If `rawVal` does not decode to an escrow record object.
   */
  public parseEscrowRecord(rawVal: xdr.ScVal): EscrowRecordView {
    const native = scValToNative(rawVal);
    if (!native || typeof native !== "object") {
      throw new Error("Invalid escrow record ScVal");
    }

    let status = EscrowContractState.Funded;
    const rawStatus = native.status?.name || native.status || "";
    if (rawStatus === "Disbursed") status = EscrowContractState.Disbursed;
    else if (rawStatus === "Refunded") status = EscrowContractState.Refunded;
    else if (rawStatus === "Disputed") status = EscrowContractState.Disputed;

    let profileHashHex = "";
    if (
      native.profile_hash instanceof Uint8Array ||
      Buffer.isBuffer(native.profile_hash)
    ) {
      profileHashHex = Buffer.from(native.profile_hash).toString("hex");
    } else if (typeof native.profile_hash === "string") {
      profileHashHex = native.profile_hash;
    }

    return {
      payer: String(native.payer || ""),
      beneficiary: String(native.beneficiary || ""),
      token: String(native.token || ""),
      amount: BigInt(native.amount ?? 0),
      profileHashHex,
      status,
      unlockTimestamp: BigInt(native.unlock_timestamp ?? 0),
    };
  }

  /**
   * Converts a contract return ScVal into its native JavaScript value.
   *
   * @param scVal - Return value produced by a contract simulation or
   *   transaction result.
   * @returns The native value decoded by the Stellar SDK. Integers are returned
   *   as `bigint`; structured contract values are returned as objects or
   *   arrays.
   */
  public decodeContractResult(scVal: xdr.ScVal): any {
    return scValToNative(scVal);
  }
}

export * from "./crypto";
export * from "./units";
export * from "./sep38";
export * from "./ttl";
export * from "./encoding";
export * from "./simulation";
export * from "./errors";
