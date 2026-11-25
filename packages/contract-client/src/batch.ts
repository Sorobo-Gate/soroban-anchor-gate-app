/**
 * Offline transaction assembly, base64 XDR serialization, and submission.
 *
 * Air-gapped cold storage and enterprise batch signing need the transaction to
 * be built on one machine, moved as text, signed elsewhere, and submitted from
 * a third process. This module provides exactly that boundary:
 *
 * ```ts
 * // Online machine: build and export
 * const unsignedXDR = buildUnsignedXDR({
 *   sourceAccount: "G...",
 *   sequence: "1234",
 *   contractId: "C...",
 *   method: "get_escrow",
 *   args: [nativeToScVal(1n, { type: "u64" })],
 *   networkPassphrase: "Test SDF Network ; September 2015",
 * });
 *
 * // Offline machine: sign, then move the envelope back
 * const signedXDR = await signer.sign(unsignedXDR);
 *
 * // Online machine: submit and wait for the ledger
 * const receipt = await submitSignedXDR(signedXDR, { config });
 * ```
 *
 * `buildUnsignedXDR` is pure and synchronous: it never contacts RPC, which is
 * what makes it safe for an air-gapped signer. Callers supply the source
 * account's current sequence number; `submitSignedXDR` then decodes the signed
 * envelope, rejects unsigned or fee-bump envelopes, submits it through Soroban
 * RPC, and polls until the transaction settles.
 *
 * @packageDocumentation
 */

import {
  Account,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Memo,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { validateClientConfig } from "./index";
import type { ClientConfig } from "./index";
import { pollTransactionStatus } from "./polling";
import { parseContractError } from "./errors";
import type { ContractError } from "./errors";

/** Default transaction timeout, in seconds, applied when none is supplied. */
export const DEFAULT_TRANSACTION_TIMEOUT_SECONDS = 30;

/**
 * Everything needed to assemble one contract invocation offline.
 */
export interface ContractCall {
  /** Stellar `G...` account that pays the fee and supplies the sequence. */
  sourceAccount: string;
  /**
   * Current sequence number of `sourceAccount`, as a decimal string.
   *
   * Supplying it keeps assembly offline. Read it from Horizon or Soroban RPC
   * before going air-gapped. The assembled transaction carries
   * `sequence + 1`, matching `TransactionBuilder`'s account semantics.
   */
  sequence: string;
  /** Soroban contract ID (`C...`) to invoke. */
  contractId: string;
  /** Contract method name, for example `create_escrow`. */
  method: string;
  /** ScVal arguments in contract call order. */
  args?: xdr.ScVal[];
  /** Stellar network passphrase the envelope is bound to. */
  networkPassphrase: string;
  /** Base fee in stroops as a decimal string. Defaults to `100`. */
  fee?: string;
  /** Transaction timeout in seconds. Defaults to 30. */
  timeoutSeconds?: number;
  /** Optional memo text, at most 28 UTF-8 bytes. */
  memo?: string;
}

/** Failure categories for {@link submitSignedXDR}. */
export type TransactionSubmissionErrorKind =
  | "rejected"
  | "retryable"
  | "failed"
  | "timeout";

/**
 * Raised when a signed envelope cannot be submitted or never settles.
 */
export class TransactionSubmissionError extends Error {
  /** Failure category suitable for retry decisions. */
  public readonly kind: TransactionSubmissionErrorKind;

  /** Transaction hash, when the RPC server assigned one. */
  public readonly hash?: string;

  /** Sanitized RPC diagnostic, when the server provided one. */
  public readonly rpcMessage?: string;

  /** Typed contract error, when the failure carried a contract code. */
  public readonly contractError?: ContractError;

  /** `true` only for failures the caller can safely retry. */
  public readonly retryable: boolean;

  constructor(
    message: string,
    kind: TransactionSubmissionErrorKind,
    details: {
      hash?: string;
      rpcMessage?: string;
      contractError?: ContractError;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: details.cause });
    this.name = "TransactionSubmissionError";
    this.kind = kind;
    this.hash = details.hash;
    this.rpcMessage = details.rpcMessage;
    this.contractError = details.contractError;
    this.retryable = kind === "retryable";
  }
}

/**
 * Options for {@link submitSignedXDR}.
 */
export interface SubmitSignedXDROptions {
  /** Network passphrase the signed envelope is bound to. */
  networkPassphrase: string;
  /** Injectable Soroban RPC server, primarily for tests or custom transports. */
  server?: Pick<rpc.Server, "sendTransaction" | "getTransaction">;
  /** Contract and RPC settings used to build a server when `server` is absent. */
  config?: ClientConfig;
  /** Overall polling deadline in milliseconds. Defaults to 60 seconds. */
  timeoutMs?: number;
  /** First poll delay in milliseconds. Defaults to 500. */
  initialDelayMs?: number;
  /** Maximum poll delay in milliseconds. Defaults to 5,000. */
  maxDelayMs?: number;
}

/**
 * Successful submission receipt.
 */
export interface SignedXDRSubmission {
  /** Transaction hash reported by Soroban RPC. */
  hash: string;
  /** Terminal status; failures reject instead of resolving. */
  status: "SUCCESS";
  /** Ledger the transaction was included in, when reported. */
  ledger?: number;
  /** Number of `getTransaction` polls made. */
  attempts: number;
  /** Milliseconds between the first poll and settlement. */
  elapsedMs: number;
}

const SEQUENCE_PATTERN = /^\d+$/;
const METHOD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_MEMO_BYTES = 28;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  return "unknown error";
}

function assertContractCall(invocation: ContractCall): void {
  if (!invocation || typeof invocation !== "object") {
    throw new TypeError("A contract invocation is required.");
  }
  const {
    sourceAccount,
    sequence,
    contractId,
    method,
    args,
    networkPassphrase,
    fee,
    timeoutSeconds,
    memo,
  } = invocation;

  if (!sourceAccount || !StrKey.isValidEd25519PublicKey(sourceAccount)) {
    throw new Error(`Invalid source account: ${String(sourceAccount)}`);
  }
  if (typeof sequence !== "string" || !SEQUENCE_PATTERN.test(sequence)) {
    throw new Error(
      "sequence must be the source account's current sequence number as a decimal string."
    );
  }
  if (!contractId || !StrKey.isValidContract(contractId)) {
    throw new Error(`Invalid contract ID format: ${String(contractId)}`);
  }
  if (typeof method !== "string" || !METHOD_PATTERN.test(method)) {
    throw new Error(`Invalid contract method name: ${String(method)}`);
  }
  if (
    typeof networkPassphrase !== "string" ||
    networkPassphrase.trim() === ""
  ) {
    throw new Error("Network passphrase cannot be empty");
  }
  if (args !== undefined && !Array.isArray(args)) {
    throw new TypeError("args must be an array of Soroban ScVal values.");
  }
  if (fee !== undefined && (typeof fee !== "string" || !SEQUENCE_PATTERN.test(fee))) {
    throw new Error("fee must be a decimal string of stroops, for example \"100\".");
  }
  if (
    timeoutSeconds !== undefined &&
    (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0)
  ) {
    throw new Error("timeoutSeconds must be a positive integer.");
  }
  if (memo !== undefined) {
    if (typeof memo !== "string") {
      throw new TypeError("memo must be a string.");
    }
    if (Buffer.byteLength(memo, "utf8") > MAX_MEMO_BYTES) {
      throw new Error(`memo cannot exceed ${MAX_MEMO_BYTES} UTF-8 bytes.`);
    }
  }
}

/**
 * Builds one contract invocation and serializes it as an unsigned base64
 * transaction envelope.
 *
 * The function is pure: it performs no network requests, so it can run inside
 * an air-gapped environment. It validates the source account, sequence,
 * contract ID, method name, fee, timeout, and memo before serializing.
 *
 * @param invocation - Source account, contract call, and network settings.
 * @returns Base64-encoded transaction envelope XDR.
 * @throws {Error} If any field is malformed or the operation cannot be built.
 *
 * @example
 * ```ts
 * const unsignedXDR = buildUnsignedXDR({
 *   sourceAccount: payer,
 *   sequence: "4294967296",
 *   contractId: config.contractId,
 *   method: "refund",
 *   args: client.buildRefundTx(7n),
 *   networkPassphrase: config.networkPassphrase,
 * });
 * ```
 */
export function buildUnsignedXDR(invocation: ContractCall): string {
  assertContractCall(invocation);

  const contract = new Contract(invocation.contractId);
  const operation = contract.call(invocation.method, ...(invocation.args ?? []));
  const source = new Account(invocation.sourceAccount, invocation.sequence);
  const builder = new TransactionBuilder(source, {
    fee: invocation.fee ?? BASE_FEE,
    networkPassphrase: invocation.networkPassphrase,
  });

  builder.addOperation(operation);
  if (invocation.memo !== undefined) {
    builder.addMemo(Memo.text(invocation.memo));
  }
  builder.setTimeout(
    invocation.timeoutSeconds ?? DEFAULT_TRANSACTION_TIMEOUT_SECONDS
  );

  return builder.build().toXDR();
}

/**
 * Decodes a base64 transaction envelope for inspection or round-trip tests.
 *
 * @param transactionXDR - Base64 envelope produced by {@link buildUnsignedXDR}
 *   or returned by a wallet.
 * @param networkPassphrase - Passphrase the envelope is bound to.
 * @returns The parsed transaction or fee-bump transaction.
 * @throws {Error} If the XDR or passphrase is invalid, or the envelope cannot
 *   be decoded.
 */
export function decodeTransactionXDR(
  transactionXDR: string,
  networkPassphrase: string
): Transaction | FeeBumpTransaction {
  if (typeof transactionXDR !== "string" || transactionXDR.trim() === "") {
    throw new TypeError("Transaction XDR must be a non-empty base64 string.");
  }
  if (
    typeof networkPassphrase !== "string" ||
    networkPassphrase.trim() === ""
  ) {
    throw new Error("Network passphrase cannot be empty");
  }
  try {
    return TransactionBuilder.fromXDR(transactionXDR, networkPassphrase);
  } catch (error) {
    throw new Error(
      `Invalid transaction XDR: ${errorMessage(error)}`,
      { cause: error }
    );
  }
}

/**
 * Submits a signed base64 envelope through Soroban RPC and waits for a ledger.
 *
 * The envelope must already carry at least one signature. Fee-bump envelopes
 * are rejected so the caller stays explicit about which transaction is signed.
 * `PENDING` and duplicate submissions are polled until they settle or the
 * deadline expires.
 *
 * @param signedXDR - Signed base64 envelope returned by a wallet adapter.
 * @param options - Network passphrase plus RPC server or client configuration.
 * @returns The settled submission receipt.
 * @throws {TransactionSubmissionError} When the envelope is unsigned, the RPC
 *   rejects it, or it does not settle before the deadline.
 * @throws {Error} When neither `server` nor `config` is provided.
 */
export async function submitSignedXDR(
  signedXDR: string,
  options: SubmitSignedXDROptions
): Promise<SignedXDRSubmission> {
  if (!options || typeof options !== "object") {
    throw new TypeError("Submission options are required.");
  }

  const envelope = decodeTransactionXDR(signedXDR, options.networkPassphrase);
  if (envelope instanceof FeeBumpTransaction) {
    throw new TransactionSubmissionError(
      "Fee-bump envelopes are not supported by submitSignedXDR; submit the inner transaction instead.",
      "rejected"
    );
  }
  if (envelope.signatures.length === 0) {
    throw new TransactionSubmissionError(
      "The transaction envelope is not signed. Sign it with a wallet adapter before submitting.",
      "rejected"
    );
  }

  let server: Pick<rpc.Server, "sendTransaction" | "getTransaction">;
  if (options.server) {
    server = options.server;
  } else {
    if (!options.config) {
      throw new Error("Either options.server or options.config must be provided");
    }
    validateClientConfig(options.config);
    server = new rpc.Server(options.config.rpcUrl, {
      allowHttp: options.config.rpcUrl.startsWith("http://"),
    });
  }

  let send: rpc.Api.SendTransactionResponse;
  try {
    send = await server.sendTransaction(envelope);
  } catch (error) {
    throw new TransactionSubmissionError(
      `Soroban RPC failed to accept the signed transaction: ${errorMessage(error)}`,
      "retryable",
      { cause: error }
    );
  }

  const status = String(send.status);
  const hash =
    typeof send.hash === "string" && send.hash !== "" ? send.hash : undefined;

  if (status === "ERROR") {
    throw new TransactionSubmissionError(
      "Soroban RPC rejected the signed transaction",
      "rejected",
      { hash, rpcMessage: status }
    );
  }
  if (status === "TRY_AGAIN_LATER") {
    throw new TransactionSubmissionError(
      "Soroban RPC asked the client to retry the submission later.",
      "retryable",
      { hash, rpcMessage: status }
    );
  }
  if (!hash) {
    throw new TransactionSubmissionError(
      "Soroban RPC did not return a transaction hash for the submission.",
      "failed",
      { rpcMessage: status }
    );
  }

  try {
    const receipt = await pollTransactionStatus(hash, {
      server,
      timeoutMs: options.timeoutMs,
      initialDelayMs: options.initialDelayMs,
      maxDelayMs: options.maxDelayMs,
    });
    return {
      hash,
      status: "SUCCESS",
      ledger: receipt.ledger,
      attempts: receipt.attempts,
      elapsedMs: receipt.elapsedMs,
    };
  } catch (error) {
    const message = errorMessage(error);
    const timedOut = /timed out/i.test(message);
    const contractError = parseContractError(error, {
      contractId: options.config?.contractId,
    });
    throw new TransactionSubmissionError(
      timedOut
        ? `Transaction ${hash} was submitted but did not settle before the polling deadline. ${message}`
        : `Transaction ${hash} did not settle successfully: ${message}`,
      timedOut ? "timeout" : "failed",
      {
        hash,
        rpcMessage: message,
        contractError,
        cause: error,
      }
    );
  }
}
