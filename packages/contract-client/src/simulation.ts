/**
 * Create-escrow transaction simulation and fee estimation.
 *
 * @packageDocumentation
 */

import {
  Account,
  BASE_FEE,
  rpc,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { EscrowGateClient, validateClientConfig } from "./index";
import type { ClientConfig, EscrowCreateParams } from "./index";

/**
 * Parameters for simulating `create_escrow`.
 *
 * This adds the RPC and network configuration needed by the free simulation
 * helper to the existing {@link EscrowCreateParams} contract.
 */
export interface CreateEscrowParams extends EscrowCreateParams {
  /** Contract ID, Soroban RPC endpoint, and network passphrase. */
  config: ClientConfig;
}

/** Options for customizing the RPC transport used by {@link simulateCreateEscrow}. */
export interface SimulateCreateEscrowOptions {
  /**
   * RPC implementation, primarily useful for tests or custom transports.
   * It is only used to fetch the payer account and simulate the transaction;
   * it is never asked to sign or submit it.
   */
  server?: Pick<rpc.Server, "getAccount" | "simulateTransaction">;
  /**
   * Optional RPC request timeout in milliseconds. The Stellar SDK defaults to
   * no timeout when this is omitted.
   */
  timeoutMs?: number;
}

/** Classification for errors raised while simulating an escrow creation. */
export type CreateEscrowSimulationErrorKind =
  | "invalid_input"
  | "rpc"
  | "simulation"
  | "invalid_response";

/**
 * A simulation failure with a stable category and, when recognized, a
 * machine-readable escrow contract error code.
 */
export class CreateEscrowSimulationError extends Error {
  /** Error category suitable for programmatic handling. */
  public readonly kind: CreateEscrowSimulationErrorKind;

  /** Contract error number from the Soroban host response, when present. */
  public readonly contractErrorCode?: number;

  /** Name mapped from the Anchor Gate contract's documented error enum. */
  public readonly contractErrorName?: string;

  /** Sanitized RPC or simulation message, when the server provided one. */
  public readonly rpcMessage?: string;

  /** Structured JSON-RPC or transport code, when the SDK exposes one. */
  public readonly rpcCode?: number | string;

  constructor(
    message: string,
    kind: CreateEscrowSimulationErrorKind,
    details: {
      contractErrorCode?: number;
      contractErrorName?: string;
      rpcMessage?: string;
      rpcCode?: number | string;
    } = {}
  ) {
    super(message);
    this.name = "CreateEscrowSimulationError";
    this.kind = kind;
    this.contractErrorCode = details.contractErrorCode;
    this.contractErrorName = details.contractErrorName;
    this.rpcMessage = details.rpcMessage;
    this.rpcCode = details.rpcCode;
  }
}

/**
 * Fee and ledger information returned for a simulated `create_escrow` call.
 */
export interface CreateEscrowSimulationResult {
  /**
   * Soroban resource fee estimate, in stroops, from RPC `minResourceFee`.
   * This value is represented as bigint to preserve the RPC's integer
   * precision.
   */
  estimatedResourceFeeStroops: bigint;
  /**
   * Fee on the SDK-assembled unsigned transaction, in stroops. It includes
   * the resource estimate plus the inclusion fee supplied to the transaction
   * builder; network surge pricing may change the final amount.
   */
  estimatedTransactionFeeStroops: bigint;
  /**
   * Latest closed ledger known to the RPC server when it answered the
   * simulation. This is not a minimum ledger sequence or a validity bound.
   */
  latestLedger?: number;
  /** Whether RPC reports that a separate ledger-entry restoration is needed. */
  requiresRestore: boolean;
  /**
   * Resource fee estimate for the separate restoration transaction, in
   * stroops, when `requiresRestore` is true. This is not included in
   * `estimatedTransactionFeeStroops`.
   */
  estimatedRestoreResourceFeeStroops?: bigint;
}

const ESCROW_ERROR_DIAGNOSTICS: Record<
  number,
  { name: string; description: string }
> = {
  1: {
    name: "NotInitialized",
    description: "The escrow contract has not been initialized.",
  },
  2: {
    name: "AlreadyInitialized",
    description: "The escrow contract has already been initialized.",
  },
  3: {
    name: "Unauthorized",
    description: "The payer is not authorized to create this escrow.",
  },
  4: {
    name: "EscrowNotFound",
    description: "The requested escrow does not exist.",
  },
  5: {
    name: "InvalidStatus",
    description: "The escrow is not in a state that permits this operation.",
  },
  6: {
    name: "UnlockTimeNotReached",
    description: "The escrow unlock time has not been reached.",
  },
  7: {
    name: "UnlockTimePassed",
    description: "The escrow unlock time has already passed.",
  },
  8: {
    name: "ZeroAmount",
    description: "The escrow amount must be greater than zero.",
  },
  9: {
    name: "InvalidBps",
    description: "The supplied basis points are invalid.",
  },
  10: {
    name: "ArithmeticOverflow",
    description: "An escrow arithmetic operation exceeded its supported range.",
  },
  11: {
    name: "TokenNotWhitelisted",
    description: "The token is not on the escrow contract whitelist.",
  },
  12: {
    name: "InvalidDisputeSplit",
    description: "The dispute split is invalid.",
  },
  13: {
    name: "EmptyDisbursement",
    description: "The disbursement list cannot be empty.",
  },
  14: {
    name: "TooManyDisbursements",
    description: "The disbursement list contains too many entries.",
  },
  15: {
    name: "InvalidDisbursementAmount",
    description: "A disbursement amount is invalid.",
  },
  16: {
    name: "DisbursementMismatch",
    description: "The disbursement amounts do not match the escrow amount.",
  },
  17: {
    name: "ClawbackNotAllowed",
    description: "The token's clawback configuration is not allowed.",
  },
  18: {
    name: "ProposalNotFound",
    description: "The requested whitelist proposal does not exist.",
  },
  19: {
    name: "ProposalAlreadyExecuted",
    description: "The whitelist proposal has already been executed.",
  },
  20: {
    name: "CannotConfirmOwnProposal",
    description: "A proposal creator cannot confirm their own proposal.",
  },
  21: {
    name: "AdminAlreadyExists",
    description: "The administrator is already registered.",
  },
  22: {
    name: "CannotRemoveLastAdmin",
    description: "The contract cannot remove its last administrator.",
  },
  23: {
    name: "AdminNotFound",
    description: "The requested administrator is not registered.",
  },
  24: {
    name: "MigrationFailed",
    description: "The contract migration could not be completed.",
  },
};

const CONTRACT_ERROR_PATTERN = /\bError\(Contract,\s*#(\d+)\)/;
const MAX_DIAGNOSTIC_LENGTH = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeDiagnosticText(value: string): string {
  const withoutUrls = value.replace(
    /\bhttps?:\/\/[^\s<>"']+/gi,
    (rawUrl) => {
      try {
        const url = new URL(rawUrl.replace(/[),.;]+$/, ""));
        return `${url.protocol}//${url.host}/[redacted]`;
      } catch {
        return "[URL redacted]";
      }
    }
  );
  return withoutUrls
    .replace(
      /(authorization|access[_-]?token|api[_-]?key|secret|password|private[_ -]?key)(\s*[:=]\s*)([^\s,;&]+)/gi,
      "$1$2[redacted]"
    )
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[redacted]")
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message : "";
    const code =
      typeof error.code === "string" || typeof error.code === "number"
        ? error.code
        : undefined;
    if (code !== undefined && message) return `RPC error ${code}: ${message}`;
    if (message) return message;
    if (typeof error.name === "string") return error.name;
  }
  return "Unexpected SDK error";
}

function structuredRpcCode(error: unknown): number | string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" || typeof error.code === "number"
    ? error.code
    : undefined;
}

function inputError(error: unknown): CreateEscrowSimulationError {
  const detail = safeDiagnosticText(errorText(error));
  return new CreateEscrowSimulationError(
    `Invalid create-escrow simulation input: ${detail}`,
    "invalid_input"
  );
}

function rpcError(action: string, error: unknown): CreateEscrowSimulationError {
  const detail = safeDiagnosticText(errorText(error));
  return new CreateEscrowSimulationError(
    `Soroban RPC failed while ${action}: ${detail}`,
    "rpc",
    { rpcMessage: detail, rpcCode: structuredRpcCode(error) }
  );
}

function invalidResponse(message: string): CreateEscrowSimulationError {
  return new CreateEscrowSimulationError(message, "invalid_response");
}

function parseUnsignedInteger(value: unknown, fieldName: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw invalidResponse(`Simulation response has an invalid ${fieldName}.`);
  }
  try {
    return BigInt(value);
  } catch {
    throw invalidResponse(`Simulation response has an invalid ${fieldName}.`);
  }
}

function parseLatestLedger(value: unknown): number | undefined {
  if (typeof value === "undefined") return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw invalidResponse("Simulation response has an invalid latestLedger.");
  }
  return value;
}

function contractErrorCode(error: string): number | undefined {
  const match = CONTRACT_ERROR_PATTERN.exec(error);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function errorOriginIsEscrowContract(
  events: unknown,
  escrowContractId: string
): boolean {
  if (!Array.isArray(events)) return false;
  const contractIds: string[] = [];
  for (const diagnostic of events) {
    if (!isRecord(diagnostic) || !isRecord(diagnostic.event)) continue;
    const id = diagnostic.event.contractId;
    if (!isRecord(id) || !(id.value instanceof Uint8Array) || id.value.length !== 32) {
      continue;
    }
    try {
      contractIds.push(StrKey.encodeContract(id.value));
    } catch {
      // Ignore malformed diagnostic event data; it cannot establish the error source.
    }
  }
  return contractIds.length > 0 && contractIds.every((id) => id === escrowContractId);
}

function simulationError(
  error: string,
  events: unknown,
  escrowContractId: string
): CreateEscrowSimulationError {
  const safeMessage = safeDiagnosticText(error);
  const code = contractErrorCode(error);
  if (code === undefined) {
    return new CreateEscrowSimulationError(
      `Escrow simulation failed: ${safeMessage || "the RPC returned no details"}`,
      "simulation",
      { rpcMessage: safeMessage }
    );
  }

  const known = ESCROW_ERROR_DIAGNOSTICS[code];
  if (!known) {
    return new CreateEscrowSimulationError(
      `Escrow simulation failed with unknown contract error #${code}. ${safeMessage}`,
      "simulation",
      { contractErrorCode: code, rpcMessage: safeMessage }
    );
  }

  if (!errorOriginIsEscrowContract(events, escrowContractId)) {
    return new CreateEscrowSimulationError(
      `Escrow simulation failed with contract error #${code}; RPC diagnostics did not confirm that the Anchor Gate contract raised it.`,
      "simulation",
      { contractErrorCode: code, rpcMessage: safeMessage }
    );
  }

  return new CreateEscrowSimulationError(
    `Escrow simulation failed with contract error #${code} (${known.name}): ${known.description}`,
    "simulation",
    {
      contractErrorCode: code,
      contractErrorName: known.name,
      rpcMessage: safeMessage,
    }
  );
}

function validateResponseFields(
  response: Record<string, unknown>
): asserts response is Record<string, unknown> & {
  transactionData: { build: () => unknown };
  minResourceFee: string;
  result: { auth: unknown[]; retval: object };
} {
  if (
    !rpc.Api.isSimulationSuccess(
      response as unknown as rpc.Api.SimulateTransactionResponse
    )
  ) {
    throw invalidResponse("Simulation RPC returned an unexpected response structure.");
  }
  if (!Array.isArray(response.events)) {
    throw invalidResponse("Simulation response is missing diagnostic events.");
  }
  if (
    !isRecord(response.transactionData) ||
    typeof response.transactionData.build !== "function"
  ) {
    throw invalidResponse("Simulation response is missing valid transaction data.");
  }
  if (typeof response.minResourceFee !== "string") {
    throw invalidResponse("Simulation response is missing minResourceFee.");
  }
  if (
    !isRecord(response.result) ||
    !Array.isArray(response.result.auth) ||
    !isRecord(response.result.retval)
  ) {
    throw invalidResponse("Simulation response is missing a valid invocation result.");
  }
}

/**
 * Simulates the escrow contract's `create_escrow` invocation and estimates
 * fees without signing or submitting a transaction.
 *
 * `params` contains the existing escrow creation fields plus a `config`
 * property with `contractId`, `rpcUrl`, and `networkPassphrase`. The payer
 * account is fetched from Soroban RPC to obtain its current transaction
 * sequence; it is used as the transaction source so the RPC can record the
 * payer's contract authorization without private keys.
 *
 * The result reports resource fees in integer stroops as `bigint`. Its
 * `latestLedger` is the server's latest closed ledger at simulation time. SDK
 * v17.2.1 does not expose a minimum ledger sequence in a simulation response,
 * so this helper does not invent one. Simulations are estimates and do not
 * guarantee transaction inclusion or successful execution later.
 *
 * @example
 * ```ts
 * const estimate = await simulateCreateEscrow({
 *   config: { contractId, rpcUrl, networkPassphrase },
 *   payer,
 *   beneficiary,
 *   token,
 *   amount: 1_000_000n,
 *   profileHashHex,
 *   lockDurationSeconds: 86_400n,
 * });
 * console.log(estimate.estimatedResourceFeeStroops.toString());
 * ```
 *
 * @param params - Escrow arguments and the client configuration.
 * @param options - Optional RPC server injection or request timeout.
 * @returns Estimated resource fees, the SDK-assembled transaction fee, and
 *   ledger/restoration information.
 * @throws {CreateEscrowSimulationError} If inputs are invalid, RPC fails,
 *   simulation rejects the invocation, or the RPC response is malformed.
 */
export async function simulateCreateEscrow(
  params: CreateEscrowParams,
  options: SimulateCreateEscrowOptions = {}
): Promise<CreateEscrowSimulationResult> {
  let client: EscrowGateClient;
  let operation: xdr.Operation;
  let config: ClientConfig;
  let payer: string;
  let timeoutMs: number | undefined;

  try {
    if (!isRecord(params) || !isRecord(params.config)) {
      throw new Error("config is required");
    }
    if (options === null || typeof options !== "object") {
      throw new Error("options must be an object");
    }
    timeoutMs = options.timeoutMs;
    if (
      typeof timeoutMs !== "undefined" &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    ) {
      throw new Error("timeoutMs must be a positive safe integer");
    }

    config = { ...(params.config as unknown as ClientConfig) };
    payer = params.payer;
    validateClientConfig(config);
    if (!StrKey.isValidEd25519PublicKey(payer)) {
      throw new Error("payer must be an Ed25519 account address usable as the transaction source");
    }

    client = new EscrowGateClient(config);
    const args = client.buildCreateEscrowTx({
      payer,
      beneficiary: params.beneficiary,
      token: params.token,
      amount: params.amount,
      profileHashHex: params.profileHashHex,
      lockDurationSeconds: params.lockDurationSeconds,
    });
    operation = client.buildOperation("create_escrow", args);
  } catch (error) {
    throw inputError(error);
  }

  let server = options.server;
  if (!server) {
    try {
      server = new rpc.Server(config.rpcUrl, {
        allowHttp: config.rpcUrl.startsWith("http://"),
        ...(timeoutMs ? { timeout: timeoutMs } : {}),
      });
    } catch (error) {
      throw inputError(error);
    }
  }

  let payerAccount: Account;
  try {
    payerAccount = await server.getAccount(payer);
  } catch (error) {
    throw rpcError("fetching the payer account sequence", error);
  }

  let transaction: Transaction;
  try {
    transaction = new TransactionBuilder(payerAccount, {
      fee: BASE_FEE,
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();
  } catch (error) {
    throw inputError(error);
  }

  let rawResponse: unknown;
  try {
    rawResponse = await server.simulateTransaction(transaction);
  } catch (error) {
    throw rpcError("simulating create_escrow", error);
  }

  if (!isRecord(rawResponse)) {
    throw invalidResponse("Simulation RPC returned a non-object response.");
  }
  if ("error" in rawResponse) {
    if (typeof rawResponse.error !== "string") {
      throw invalidResponse("Simulation RPC returned a malformed error response.");
    }
    throw simulationError(rawResponse.error, rawResponse.events, config.contractId);
  }

  validateResponseFields(rawResponse);
  const response = rawResponse as unknown as rpc.Api.SimulateTransactionSuccessResponse;
  const estimatedResourceFeeStroops = parseUnsignedInteger(
    response.minResourceFee,
    "minResourceFee"
  );

  let requiresRestore = false;
  let estimatedRestoreResourceFeeStroops: bigint | undefined;
  if ("restorePreamble" in rawResponse) {
    const restorePreamble = rawResponse.restorePreamble;
    if (
      !rpc.Api.isSimulationRestore(response) ||
      !isRecord(restorePreamble) ||
      typeof restorePreamble.minResourceFee !== "string" ||
      !isRecord(restorePreamble.transactionData) ||
      typeof restorePreamble.transactionData.build !== "function"
    ) {
      throw invalidResponse("Simulation response has a malformed restorePreamble.");
    }
    requiresRestore = true;
    estimatedRestoreResourceFeeStroops = parseUnsignedInteger(
      restorePreamble.minResourceFee,
      "restorePreamble.minResourceFee"
    );
  }

  let estimatedTransactionFeeStroops: bigint;
  try {
    const assembled = rpc.assembleTransaction(transaction, response).build();
    estimatedTransactionFeeStroops = parseUnsignedInteger(
      assembled.fee,
      "assembled transaction fee"
    );
  } catch (error) {
    if (error instanceof CreateEscrowSimulationError) throw error;
    throw invalidResponse(
      `Stellar SDK could not assemble the simulation response: ${safeDiagnosticText(errorText(error))}`
    );
  }

  return {
    estimatedResourceFeeStroops,
    estimatedTransactionFeeStroops,
    latestLedger: parseLatestLedger(rawResponse.latestLedger),
    requiresRestore,
    ...(estimatedRestoreResourceFeeStroops === undefined
      ? {}
      : { estimatedRestoreResourceFeeStroops }),
  };
}
