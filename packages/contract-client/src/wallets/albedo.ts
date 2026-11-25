/**
 * Albedo wallet adapter.
 *
 * Albedo is a web-based Stellar signer that injects `window.albedo` when the
 * Albedo browser extension is installed. The adapter accepts an injected
 * provider so headless tests and server-side flows can supply their own.
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

/** Albedo network selector (`public` or `testnet`). */
export type AlbedoNetwork = "public" | "testnet";

/** Options forwarded to `albedo.tx`. */
export interface AlbedoTxParams {
  /** Base64 transaction envelope to sign. */
  xdr: string;
  /** Albedo network selector. */
  network?: AlbedoNetwork;
  /** Account expected to sign. */
  pubkey?: string;
  /** Whether Albedo should submit the signed transaction. */
  submit?: boolean;
}

/**
 * Structural subset of the Albedo provider used by the adapter.
 */
export interface AlbedoProvider {
  /** Requests the user's public key. */
  publicKey?(params?: Record<string, unknown>): Promise<unknown> | unknown;
  /** Signs (and optionally submits) a transaction envelope. */
  tx?(params: AlbedoTxParams): Promise<unknown> | unknown;
}

/** Construction options for {@link AlbedoAdapter}. */
export interface AlbedoAdapterOptions {
  /** Pre-resolved Albedo provider, injected instead of auto-detection. */
  provider?: AlbedoProvider;
  /** Network selector reported to Albedo. */
  network?: AlbedoNetwork;
  /** Network passphrase used to derive {@link AlbedoAdapterOptions.network}. */
  networkPassphrase?: string;
}

function coerceAlbedoProvider(candidate: unknown): AlbedoProvider | undefined {
  if (!isRecord(candidate)) return undefined;
  const hasFunction =
    typeof candidate.publicKey === "function" ||
    typeof candidate.tx === "function";
  return hasFunction ? (candidate as AlbedoProvider) : undefined;
}

function detectAlbedoGlobal(): AlbedoProvider | undefined {
  const scope = globalThis as unknown as Record<string, unknown>;
  return (
    coerceAlbedoProvider(scope.albedo) ??
    coerceAlbedoProvider(scope.albedoWallet)
  );
}

/** Maps a network passphrase to Albedo's `public` / `testnet` selector. */
function networkForPassphrase(passphrase: string): AlbedoNetwork {
  return /public/i.test(passphrase) ? "public" : "testnet";
}

function extractAddress(value: unknown): string | undefined {
  if (typeof value === "string" && StrKey.isValidEd25519PublicKey(value)) {
    return value;
  }
  const candidate = readString(
    value,
    "pubkey",
    "publicKey",
    "public_key",
    "address"
  );
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
          "signed_envelope_xdr",
          "signedEnvelopeXdr",
          "signedXDR",
          "signed_xdr",
          "xdr"
        );
  return isBase64Envelope(candidate) ? candidate : undefined;
}

/**
 * Albedo adapter implementing {@link WalletAdapter}.
 */
export class AlbedoAdapter implements WalletAdapter {
  /** Stable adapter identifier. */
  public readonly id: WalletId = "albedo";

  /** Human-readable wallet name. */
  public readonly name = "Albedo";

  private readonly options: AlbedoAdapterOptions;

  private provider?: AlbedoProvider;

  private address?: string;

  constructor(options: AlbedoAdapterOptions = {}) {
    this.options = options;
    this.provider = options.provider;
  }

  /** Reports whether the Albedo provider can be resolved. */
  public async isAvailable(): Promise<boolean> {
    try {
      this.resolveProvider();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Requests the public key and resolves with the unlocked account.
   *
   * @throws {WalletError} With code `not_installed` when Albedo is missing, or
   *   `rejected` when the user declines.
   */
  public async connect(): Promise<WalletConnection> {
    const address = await this.getAddress();
    return {
      address,
      network: this.options.network,
      networkPassphrase: this.options.networkPassphrase,
    };
  }

  /**
   * Requests (or reuses) the Albedo public key.
   *
   * @throws {WalletError} With code `not_connected` when Albedo does not return
   *   an account.
   */
  public async getAddress(): Promise<string> {
    const provider = this.resolveProvider();
    if (typeof provider.publicKey !== "function") {
      if (this.address) return this.address;
      throw new WalletError(
        "not_connected",
        this.id,
        "The resolved Albedo provider does not expose publicKey()."
      );
    }

    let raw: unknown;
    try {
      raw = await provider.publicKey({});
    } catch (error) {
      throw this.wrapFailure(error, "public key request");
    }

    const failure = readErrorMessage(raw);
    if (failure) {
      throw new WalletError(
        isRejectionMessage(failure) ? "rejected" : "not_connected",
        this.id,
        `Albedo did not return an account: ${failure}`,
        raw
      );
    }

    const address = extractAddress(raw);
    if (!address) {
      throw new WalletError(
        "malformed_response",
        this.id,
        "Albedo returned a public key response without a valid Stellar account.",
        raw
      );
    }
    this.address = address;
    return address;
  }

  /**
   * Signs a base64 transaction envelope with Albedo.
   *
   * @param xdr - Unsigned base64 envelope.
   * @param options - Network passphrase and optional account selection.
   * @returns The base64 signed envelope.
   * @throws {WalletError} When Albedo rejects, is unavailable, or returns an
   *   unusable payload.
   */
  public async signTransaction(
    xdr: string,
    options: WalletSignOptions
  ): Promise<string> {
    assertSignRequest(this.id, xdr, options);
    const provider = this.resolveProvider();
    if (typeof provider.tx !== "function") {
      throw new WalletError(
        "not_installed",
        this.id,
        "The resolved Albedo provider does not expose tx()."
      );
    }

    const network =
      this.options.network ??
      networkForPassphrase(options.networkPassphrase);
    const pubkey = options.address ?? this.address;
    const params: AlbedoTxParams = { xdr, network };
    if (pubkey) params.pubkey = pubkey;
    if (typeof options.submit === "boolean") params.submit = options.submit;

    let response: unknown;
    try {
      response = await provider.tx(params);
    } catch (error) {
      throw this.wrapFailure(error, "signing");
    }

    const failure = readErrorMessage(response);
    if (failure) {
      throw new WalletError(
        isRejectionMessage(failure) ? "rejected" : "sign_failed",
        this.id,
        `Albedo could not sign the transaction: ${failure}`,
        response
      );
    }

    const signed = extractSignedXdr(response);
    if (!signed) {
      throw new WalletError(
        "malformed_response",
        this.id,
        "Albedo returned a signing response without a base64 transaction envelope.",
        response
      );
    }
    return signed;
  }

  /** Forgets the cached address. */
  public async disconnect(): Promise<void> {
    this.address = undefined;
  }

  private resolveProvider(): AlbedoProvider {
    if (!this.provider) {
      const detected = detectAlbedoGlobal();
      if (!detected) {
        throw new WalletError(
          "not_installed",
          this.id,
          "Albedo was not found. Install the Albedo extension or pass its provider via new AlbedoAdapter({ provider })."
        );
      }
      this.provider = detected;
    }
    return this.provider;
  }

  private wrapFailure(error: unknown, action: string): WalletError {
    if (error instanceof WalletError) return error;
    const message = readErrorMessage(error);
    return new WalletError(
      isRejectionMessage(message) ? "rejected" : "sign_failed",
      this.id,
      `Albedo failed during ${action}: ${message ?? "unknown error"}`,
      error
    );
  }
}
