/**
 * Shared types, guards, and errors for the SDK's wallet integrations.
 *
 * Browser wallets inject different globals and return different result
 * envelopes, so every adapter funnels the extension response through the
 * defensive helpers in this module rather than trusting its shape.
 *
 * @packageDocumentation
 */

import { StrKey, xdr } from "@stellar/stellar-sdk";

/** Identifier of a supported wallet integration. */
export type WalletId = "freighter" | "xbull" | "albedo" | "mock";

/**
 * Options passed to {@link WalletAdapter.signTransaction}.
 */
export interface WalletSignOptions {
  /** Stellar network passphrase the transaction envelope is bound to. */
  networkPassphrase: string;
  /** Account expected to sign, when the wallet supports selecting one. */
  address?: string;
  /** Ask the wallet to submit after signing, when it supports submission. */
  submit?: boolean;
}

/**
 * Result of a successful {@link WalletAdapter.connect} call.
 */
export interface WalletConnection {
  /** Stellar `G...` account the wallet unlocked. */
  address: string;
  /** Network passphrase reported by the wallet, when available. */
  networkPassphrase?: string;
  /** Network name reported by the wallet, such as `TESTNET`. */
  network?: string;
}

/**
 * Unified interface implemented by every supported wallet.
 *
 * The contract is intentionally small: connect once, read the address, and
 * sign an unsigned transaction envelope produced by
 * {@link buildUnsignedXDR}.
 */
export interface WalletAdapter {
  /** Stable adapter identifier. */
  readonly id: WalletId;
  /** Human-readable wallet name. */
  readonly name: string;

  /**
   * Reports whether the wallet can be used in the current runtime.
   *
   * Implementations return `false` instead of throwing when the extension is
   * not installed; `connect` is where a missing wallet becomes an error.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Requests access to the wallet and resolves with the unlocked account.
   *
   * @throws {WalletError} With code `not_installed` when no wallet exists, or
   *   `rejected` when the user declines the access request.
   */
  connect(): Promise<WalletConnection>;

  /**
   * Reads the currently authorized address.
   *
   * @throws {WalletError} With code `not_connected` when access was never
   *   granted or was revoked.
   */
  getAddress(): Promise<string>;

  /**
   * Signs a base64 transaction envelope.
   *
   * @param xdr - Base64 envelope, unsigned or partially signed.
   * @param options - Network passphrase and optional account selection.
   * @returns The base64 signed envelope returned by the wallet.
   * @throws {WalletError} When the wallet is unavailable, the request is
   *   rejected, or the response cannot be interpreted.
   */
  signTransaction(xdr: string, options: WalletSignOptions): Promise<string>;

  /** Forgets the cached address, when the wallet exposes a disconnect flow. */
  disconnect?(): Promise<void>;
}

/** Machine-readable failure categories shared by all adapters. */
export type WalletErrorCode =
  | "not_installed"
  | "not_connected"
  | "rejected"
  | "invalid_request"
  | "network_mismatch"
  | "malformed_response"
  | "sign_failed";

/**
 * Normalized wallet failure.
 *
 * Every adapter converts extension-specific errors into this class so a UI can
 * branch on `error.code` without inspecting vendor strings.
 */
export class WalletError extends Error {
  /** Failure category. */
  public readonly code: WalletErrorCode;

  /** Adapter that raised the failure. */
  public readonly wallet: WalletId;

  constructor(
    code: WalletErrorCode,
    wallet: WalletId,
    message: string,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "WalletError";
    this.code = code;
    this.wallet = wallet;
  }
}

/**
 * Narrows an unknown value to a {@link WalletError}.
 *
 * @param value - Value to check.
 */
export function isWalletError(value: unknown): value is WalletError {
  return value instanceof WalletError;
}

/**
 * Narrows an unknown value to a non-null object record.
 *
 * @param value - Value to check.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the first string found under one of the supplied keys.
 *
 * @param value - Candidate object.
 * @param keys - Property names to inspect, in priority order.
 * @returns The trimmed string, or `undefined` when no non-empty string exists.
 */
export function readString(
  value: unknown,
  ...keys: readonly string[]
): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return undefined;
}

/**
 * Reports whether a plain string is a successful wallet payload rather than an
 * error description.
 *
 * Vendors such as Freighter v1, xBull's legacy `sign`, and Albedo's plain
 * responses return the account address or the signed envelope as a bare string,
 * so those must not be mistaken for failure text.
 *
 * @param text - Trimmed response string.
 */
function isSuccessPayloadString(text: string): boolean {
  if (StrKey.isValidEd25519PublicKey(text)) return true;
  try {
    xdr.TransactionEnvelope.fromXDR(text, "base64");
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts a user-facing message from an extension error envelope.
 *
 * Wallets return either `{ error: "text" }`, `{ error: { message: "text" } }`,
 * or plain strings, so all three shapes are accepted. Plain strings that are a
 * valid account address or transaction envelope are treated as success payloads
 * and produce no message.
 *
 * @param value - Wallet response or thrown value.
 * @returns The message, or `undefined` when none can be read.
 */
export function readErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return undefined;
    return isSuccessPayloadString(text) ? undefined : text;
  }
  if (value instanceof Error) return value.message || value.name;
  const direct = readString(value, "message", "error", "reason");
  if (direct) return direct;
  if (isRecord(value)) {
    return readString(value.error, "message", "reason");
  }
  return undefined;
}

/**
 * Classifies an extension failure as a user rejection.
 *
 * @param message - Raw extension or thrown message.
 */
export function isRejectionMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /reject|denied|declin|cancel|refus|not\s+allowed/i.test(message);
}

/**
 * Constrains a wallet response to a plausible base64 transaction envelope.
 *
 * @param value - Candidate envelope.
 * @returns `true` when the value looks like base64 XDR.
 */
export function isBase64Envelope(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    /^[A-Za-z0-9+/=\s]+$/.test(value)
  );
}

/**
 * Validates the inputs shared by every {@link WalletAdapter.signTransaction}.
 *
 * @param adapter - Wallet raising failures.
 * @param xdr - Candidate envelope.
 * @param options - Signing options.
 * @throws {WalletError} With code `invalid_request` for malformed arguments.
 */
export function assertSignRequest(
  adapter: WalletId,
  xdr: string,
  options: WalletSignOptions
): void {
  if (!isBase64Envelope(xdr)) {
    throw new WalletError(
      "invalid_request",
      adapter,
      "Transaction XDR must be a non-empty base64 string."
    );
  }
  if (
    !options ||
    typeof options.networkPassphrase !== "string" ||
    options.networkPassphrase.trim() === ""
  ) {
    throw new WalletError(
      "invalid_request",
      adapter,
      "A non-empty network passphrase is required to sign a transaction."
    );
  }
}
