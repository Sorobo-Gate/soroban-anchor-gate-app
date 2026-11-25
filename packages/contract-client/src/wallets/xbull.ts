/**
 * xBull wallet adapter.
 *
 * The xBull extension injects `window.xBullSDK` (also published as
 * `@creit.tech/xbull-wallet-connect`). Its API is promise-based and has
 * changed shape across releases, so the adapter accepts an injected SDK or
 * auto-detects the global and normalizes each response.
 *
 * @packageDocumentation
 */

import { StrKey } from "@stellar/stellar-sdk";
import {
  WalletError,
  assertSignRequest,
  isBase64Envelope,
  isRecord,
  isRejectionMessage,
  readErrorMessage,
  readString,
} from "./types";
import type {
  WalletAdapter,
  WalletConnection,
  WalletId,
  WalletSignOptions,
} from "./types";

/** Options forwarded to xBull's signing methods. */
export interface XBullSignParams {
  /** Selected account. */
  publicKey?: string;
  /** Selected network name, when the SDK understands it. */
  network?: string;
  /** Network passphrase, for SDK versions that accept it. */
  networkPassphrase?: string;
}

/**
 * Structural subset of the xBull SDK used by the adapter.
 */
export interface XBullSdk {
  /** Opens the extension and requests access. */
  connect?(): Promise<unknown> | unknown;
  /** Reads the authorized public key. */
  getPublicKey?(): Promise<unknown> | unknown;
  /** Signs a base64 envelope (`signXDR` in newer releases). */
  signXDR?(
    xdr: string,
    params?: XBullSignParams
  ): Promise<unknown> | unknown;
  /** Signs a base64 envelope (`sign` in older releases). */
  sign?(xdr: string, params?: XBullSignParams): Promise<unknown> | unknown;
}

/** Construction options for {@link XBullAdapter}. */
export interface XBullAdapterOptions {
  /** Pre-resolved xBull SDK, injected instead of auto-detection. */
  sdk?: XBullSdk;
  /** Network name reported to the SDK, e.g. `TESTNET`. */
  network?: string;
  /** Network passphrase reported to the SDK. */
  networkPassphrase?: string;
}

function coerceXBullSdk(candidate: unknown): XBullSdk | undefined {
  if (!isRecord(candidate)) return undefined;
  const hasFunction =
    typeof candidate.getPublicKey === "function" ||
    typeof candidate.signXDR === "function" ||
    typeof candidate.sign === "function";
  return hasFunction ? (candidate as XBullSdk) : undefined;
}

function detectXBullGlobal(): XBullSdk | undefined {
  const scope = globalThis as unknown as Record<string, unknown>;
  return (
    coerceXBullSdk(scope.xBullSDK) ??
    coerceXBullSdk(scope.xbull) ??
    coerceXBullSdk(scope.xBullWalletConnect)
  );
}

function extractAddress(value: unknown): string | undefined {
  if (typeof value === "string" && StrKey.isValidEd25519PublicKey(value)) {
    return value;
  }
  const candidate = readString(value, "publicKey", "public_key", "address");
  return candidate && StrKey.isValidEd25519PublicKey(candidate)
    ? candidate
    : undefined;
}

function extractSignedXdr(value: unknown): string | undefined {
  const candidate =
    typeof value === "string"
      ? value
      : readString(
          value,
          "signedXDR",
          "signedXdr",
          "signed_xdr",
          "signedEnvelopeXdr",
          "signed_envelope_xdr",
          "xdr"
        );
  return isBase64Envelope(candidate) ? candidate : undefined;
}

/**
 * xBull adapter implementing {@link WalletAdapter}.
 */
export class XBullAdapter implements WalletAdapter {
  /** Stable adapter identifier. */
  public readonly id: WalletId = "xbull";

  /** Human-readable wallet name. */
  public readonly name = "xBull";

  private readonly options: XBullAdapterOptions;

  private sdk?: XBullSdk;

  private address?: string;

  constructor(options: XBullAdapterOptions = {}) {
    this.options = options;
    this.sdk = options.sdk;
  }

  /** Reports whether the xBull SDK can be resolved. */
  public async isAvailable(): Promise<boolean> {
    try {
      this.resolveSdk();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Requests access and resolves with the unlocked account.
   *
   * @throws {WalletError} With code `not_installed` when the SDK is missing, or
   *   `rejected` when the user declines.
   */
  public async connect(): Promise<WalletConnection> {
    const sdk = this.resolveSdk();
    let access: unknown;
    if (typeof sdk.connect === "function") {
      try {
        access = await sdk.connect();
      } catch (error) {
        throw this.wrapFailure(error, "access request");
      }
      const failure = readErrorMessage(access);
      if (failure) {
        throw new WalletError(
          isRejectionMessage(failure) ? "rejected" : "not_connected",
          this.id,
          `xBull access was not granted: ${failure}`,
          access
        );
      }
    }

    const address = extractAddress(access) ?? (await this.getAddress());
    this.address = address;
    return {
      address,
      network: this.options.network,
      networkPassphrase: this.options.networkPassphrase,
    };
  }

  /**
   * Reads the authorized account, caching the last successful result.
   *
   * @throws {WalletError} With code `not_connected` when access has not been
   *   granted.
   */
  public async getAddress(): Promise<string> {
    const sdk = this.resolveSdk();
    if (typeof sdk.getPublicKey === "function") {
      let raw: unknown;
      try {
        raw = await sdk.getPublicKey();
      } catch (error) {
        throw this.wrapFailure(error, "address lookup");
      }
      const failure = readErrorMessage(raw);
      if (failure) {
        throw new WalletError(
          isRejectionMessage(failure) ? "rejected" : "not_connected",
          this.id,
          `xBull did not return an account: ${failure}`,
          raw
        );
      }
      const address = extractAddress(raw);
      if (address) {
        this.address = address;
        return address;
      }
    }
    if (this.address) return this.address;
    throw new WalletError(
      "not_connected",
      this.id,
      "xBull is not connected. Call connect() and approve access first."
    );
  }

  /**
   * Signs a base64 transaction envelope with xBull.
   *
   * @param xdr - Unsigned base64 envelope.
   * @param options - Network passphrase and optional account selection.
   * @returns The base64 signed envelope.
   * @throws {WalletError} When xBull rejects, is unavailable, or returns an
   *   unusable payload.
   */
  public async signTransaction(
    xdr: string,
    options: WalletSignOptions
  ): Promise<string> {
    assertSignRequest(this.id, xdr, options);
    const sdk = this.resolveSdk();
    const signer = sdk.signXDR ?? sdk.sign;
    if (typeof signer !== "function") {
      throw new WalletError(
        "not_installed",
        this.id,
        "The resolved xBull SDK does not expose signXDR()."
      );
    }

    const address = options.address ?? this.address;
    const params: XBullSignParams = {
      networkPassphrase: options.networkPassphrase,
    };
    if (address) params.publicKey = address;
    if (this.options.network) params.network = this.options.network;

    let response: unknown;
    try {
      response = await signer.call(sdk, xdr, params);
    } catch (error) {
      throw this.wrapFailure(error, "signing");
    }

    const failure = readErrorMessage(response);
    if (failure) {
      throw new WalletError(
        isRejectionMessage(failure) ? "rejected" : "sign_failed",
        this.id,
        `xBull could not sign the transaction: ${failure}`,
        response
      );
    }

    const signed = extractSignedXdr(response);
    if (!signed) {
      throw new WalletError(
        "malformed_response",
        this.id,
        "xBull returned a signing response without a base64 transaction envelope.",
        response
      );
    }
    return signed;
  }

  /** Forgets the cached address. */
  public async disconnect(): Promise<void> {
    this.address = undefined;
  }

  private resolveSdk(): XBullSdk {
    if (!this.sdk) {
      const detected = detectXBullGlobal();
      if (!detected) {
        throw new WalletError(
          "not_installed",
          this.id,
          "xBull was not found. Install the browser extension or pass its SDK via new XBullAdapter({ sdk })."
        );
      }
      this.sdk = detected;
    }
    return this.sdk;
  }

  private wrapFailure(error: unknown, action: string): WalletError {
    if (error instanceof WalletError) return error;
    const message = readErrorMessage(error);
    return new WalletError(
      isRejectionMessage(message) ? "rejected" : "sign_failed",
      this.id,
      `xBull failed during ${action}: ${message ?? "unknown error"}`,
      error
    );
  }
}
