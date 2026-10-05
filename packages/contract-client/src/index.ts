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

export interface ClientConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}

export interface EscrowCreateParams {
  payer: string;
  beneficiary: string;
  token: string;
  amount: bigint;
  profileHashHex: string;
  lockDurationSeconds: bigint;
}

export interface ReleaseToAnchorParams {
  escrowId: bigint;
  caller: string;
  anchorDisbursementAddress: string;
}

export enum EscrowContractState {
  Funded = "Funded",
  Disbursed = "Disbursed",
  Refunded = "Refunded",
}

export enum EscrowError {
  NotInitialized = 1,
  AlreadyInitialized = 2,
  Unauthorized = 3,
  EscrowNotFound = 4,
  InvalidStatus = 5,
  UnlockTimeNotReached = 6,
  UnlockTimePassed = 7,
  ZeroAmount = 8,
  InvalidBps = 9,
  ArithmeticOverflow = 10,
}

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

export function isValidAddress(address: string): boolean {
  return (
    StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address)
  );
}

export function computeProfileHash(routingInfo: string): string {
  if (!routingInfo || routingInfo.trim() === "") {
    throw new Error("Routing information cannot be empty");
  }
  return createHash("sha256").update(routingInfo.trim()).digest("hex");
}

export function validateProfileHashHex(hashHex: string): void {
  const hexRegex = /^[0-9a-fA-F]{64}$/;
  if (!hexRegex.test(hashHex)) {
    throw new Error("profileHash must be exactly 32 bytes (64 hex characters)");
  }
}

export function parseTokenAmount(amountStr: string, decimals: number = 7): bigint {
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

export function formatTokenAmount(amount: bigint, decimals: number = 7): string {
  if (amount < 0n) {
    throw new Error("Token amount cannot be negative");
  }
  const str = amount.toString().padStart(decimals + 1, "0");
  const integerPart = str.slice(0, str.length - decimals);
  const fractionalPart = str.slice(str.length - decimals).replace(/0+$/, "");
  return fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;
}

export class EscrowGateClient {
  public readonly contract: Contract;

  constructor(public readonly config: ClientConfig) {
    validateClientConfig(config);
    this.contract = new Contract(config.contractId);
  }

  public buildInitTx(admin: string, treasury: string, feeBps: number): xdr.ScVal[] {
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

  public buildReleaseToAnchorTx(params: ReleaseToAnchorParams): xdr.ScVal[] {
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

  public buildRefundTx(escrowId: bigint): xdr.ScVal[] {
    if (escrowId < 0n) {
      throw new Error("escrowId cannot be negative");
    }
    return [nativeToScVal(escrowId, { type: "u64" })];
  }

  public buildOperation(
    method: "init" | "create_escrow" | "release_to_anchor" | "refund",
    args: xdr.ScVal[]
  ): xdr.Operation {
    return this.contract.call(method, ...args);
  }

  public decodeContractResult(scVal: xdr.ScVal): any {
    return scValToNative(scVal);
  }
}
