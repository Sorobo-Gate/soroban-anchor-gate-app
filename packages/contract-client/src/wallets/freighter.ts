/**
 * Freighter wallet adapter.
 *
 * Freighter is the reference Stellar browser extension. Its API is published
 * as the `@stellar/freighter-api` package and injected as `window.freighterApi`
 * by the extension itself. This adapter uses whichever is present:
 *
 * 1. an explicitly injected {@link FreighterApi} (recommended for tests and
 *    for bundlers that prefer tree-shaken imports),
 * 2. `globalThis.freighterApi` / `globalThis.freighter`,
 * 3. a runtime import of `@stellar/freighter-api` when the host application has
 *    installed it.
 *
 * The package is intentionally not a hard dependency: server-side and
 * air-gapped consumers of this SDK must be able to import it without pulling
 * browser wallet code into their bundle.
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

/** Options forwarded to Freighter's `signTransaction`. */
export interface FreighterSignParams {
  /** Network passphrase the envelope is bound to. */
  networkPassphrase?: string;
  /** Account Freighter should sign with. */
  address?: string;
  /** Network name, for older Freighter versions. */
  network?: string;
  /** Submit the signed transaction through Freighter's RPC. */
  submit?: boolean;
}

/**
 * Structural subset of `@stellar/freighter-api` used by the adapter.
 *
 * All methods are optional and return `unknown` so the adapter tolerates the
 * shape differences between Freighter v1 (string results) and v2/v3
 * (`{ address }` / `{ signedTxXdr }` envelopes).
 */
export interface FreighterApi {
  /** Whether the extension is installed and reachable. */
  isConnected?(): Promise<unknown> | unknown;
  /** Requests account access from the user. */
  requestAccess?(): Promise<unknown> | unknown;
  /** Reads the currently authorized address. */
  getAddress?(): Promise<unknown> | unknown;
  /** Reads the connected network. */
  getNetwork?(): Promise<unknown> | unknown;
  /** Signs a base64 transaction envelope. */
  signTransaction?(
    xdr: string,
    params?: FreighterSignParams
  ): Promise<unknown> | unknown;
}

/** Construction options for {@link FreighterAdapter}. */
export interface FreighterAdapterOptions {
  /** Pre-resolved Freighter API, injected instead of auto-detection. */
  api?: FreighterApi;
  /** Network name used when the wallet does not report one. */
  network?: string;
  /** Network passphrase used when the wallet does not report one. */
  networkPassphrase?: string;
}

function coerceFreighterApi(candidate: unknown): FreighterApi | undefined {
  if (!isRecord(candidate)) return undefined;
  const hasFunction =
    typeof candidate.getAddress === "function" ||
    typeof candidate.signTransaction === "function" ||
    typeof candidate.requestAccess === "function";
  return hasFunction ? (candidate as FreighterApi) : undefined;
}

function detectFreighterGlobal(): FreighterApi | undefined {
  const scope = globalThis as unknown as Record<string, unknown>;
  return (
    coerceFreighterApi(scope.freighterApi) ?? coerceFreighterApi(scope.freighter)
  );
}

async function importFreighterApi(): Promise<FreighterApi | undefined> {
  // The specifier is a variable so TypeScript does not require the package (or
  // its types) to be installed for this SDK to compile.
  const specifier = "@stellar/freighter-api";
  try {
    const loaded: unknown = await import(specifier);
    if (isRecord(loaded)) {
      return (
        coerceFreighterApi(loaded) ?? coerceFreighterApi(loaded.default)
      );
    }
    return coerceFreighterApi(loaded);
  } catch {
    return undefined;
  }
}

function extractAddress(value: unknown): string | undefined {
  if (typeof value === "string" && StrKey.isValidEd25519PublicKey(value)) {
    return value;
  }
  const candidate = readString(
    value,
    "address",
    "publicKey",
    "pubkey",
    "public_key"
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
          "signedTxXdr",
          "signedXDR",
          "signed_xdr",
          "signedEnvelopeXdr",
          "xdr"
        );
  return isBase64Envelope(candidate) ? candidate : undefined;
}

function accessError(value: unknown): string | undefined {
  if (typeof value === "boolean") {
    return value ? undefined : "Freighter declined the access request.";
  }
  return readErrorMessage(value);
}

/**
 * Freighter adapter implementing {@link WalletAdapter}.
 *
 * @example
 * ```ts
 * const wallet = new FreighterAdapter();
 * const { address } = await wallet.connect();
 * const signedXDR = await wallet.signTransaction(unsignedXDR, {
 *   networkPassphrase: "Test SDF Network ; September 2015",
 *   address,
 * });
 * ```
 */
export class FreighterAdapter implements WalletAdapter {
  /** Stable adapter identifier. */
  public readonly id: WalletId = "freighter";

  /** Human-readable wallet name. */
  public readonly name = "Freighter";

  private readonly options: FreighterAdapterOptions;

  private api?: FreighterApi;

  private address?: string;

  constructor(options: FreighterAdapterOptions = {}) {
    this.options = options;
    this.api = options.api;
  }

  /**
   * Reports whether Freighter can be reached in this runtime.
   *
   * Resolves `false` instead of throwing when the extension or package is
   * missing.
   */
  public async isAvailable(): Promise<boolean> {
    try {
      await this.resolveApi();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Requests access and resolves with the unlocked account.
   *
   * @throws {WalletError} With code `not_installed` when no Freighter API can
   *   be resolved, or `rejected` when the user declines.
   */
  public async connect(): Promise<WalletConnection> {
    const api = await this.resolveApi();
    let access: unknown;
    if (typeof api.requestAccess === "function") {
      try {
        access = await api.requestAccess();
      } catch (error) {
        throw this.wrapFailure(error, "access request");
      }
    }

    const failure = accessError(access);
    if (failure) {
      throw new WalletError(
        isRejectionMessage(failure) ? "rejected" : "not_connected",
        this.id,
        `Freighter access was not granted: ${failure}`,
        access
      );
    }

    const applicationAddress = extractAddress(access);
    let network: string | undefined;
    let networkPassphrase: string | undefined;
    try {
      const info = await this.readNetwork(api);
      network = info.network;
      networkPassphrase = info.networkPassphrase;
    } catch {
      // Network metadata is advisory; signing still provides the passphrase.
    }

    if (applicationAddress) {
      this.address = applicationAddress;
      return {
        address: applicationAddress,
        network,
        networkPassphrase,
      };
    }

    const address = await this.getAddress();
    return { address, network, networkPassphrase };
  }

  /**
   * Reads the authorized account, caching the last successful result.
   *
   * @throws {WalletError} With code `not_connected` when access has not been
   *   granted yet.
   */
  public async getAddress(): Promise<string> {
    const api = await this.resolveApi();
    if (typeof api.getAddress === "function") {
      let raw: unknown;
      try {
        raw = await api.getAddress();
      } catch (error) {
        throw this.wrapFailure(error, "address lookup");
      }
      const failure = readErrorMessage(raw);
      if (failure) {
        throw new WalletError(
          isRejectionMessage(failure) ? "rejected" : "not_connected",
          this.id,
          `Freighter did not return an account: ${failure}`,
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
      "Freighter is not connected. Call connect() and approve access first."
    );
  }

  /**
   * Signs a base64 transaction envelope with Freighter.
   *
   * @param xdr - Unsigned base64 envelope.
   * @param options - Network passphrase and optional account selection.
   * @returns The base64 signed envelope.
   * @throws {WalletError} When Freighter rejects, is unavailable, or returns an
   *   unusable payload.
   */
  public async signTransaction(
    xdr: string,
    options: WalletSignOptions
  ): Promise<string> {
    assertSignRequest(this.id, xdr, options);
    const api = await this.resolveApi();
    if (typeof api.signTransaction !== "function") {
      throw new WalletError(
        "not_installed",
        this.id,
        "The resolved Freighter API does not expose signTransaction()."
      );
    }

    const address = options.address ?? this.address;
    const params: FreighterSignParams = {
      networkPassphrase: options.networkPassphrase,
    };
    if (address) params.address = address;
    if (this.options.network) params.network = this.options.network;
    if (typeof options.submit === "boolean") params.submit = options.submit;

    let response: unknown;
    try {
      response = await api.signTransaction(xdr, params);
    } catch (error) {
      throw this.wrapFailure(error, "signing");
    }

    const failure = readErrorMessage(response);
    if (failure) {
      throw new WalletError(
        isRejectionMessage(failure) ? "rejected" : "sign_failed",
        this.id,
        `Freighter could not sign the transaction: ${failure}`,
        response
      );
    }

    const signed = extractSignedXdr(response);
    if (!signed) {
      throw new WalletError(
        "malformed_response",
        this.id,
        "Freighter returned a signing response without a base64 transaction envelope.",
        response
      );
    }
    return signed;
  }

  /** Forgets the cached address; Freighter keeps its own grant state. */
  public async disconnect(): Promise<void> {
    this.address = undefined;
  }

  private async resolveApi(): Promise<FreighterApi> {
    if (this.api) return this.api;
    const detected = detectFreighterGlobal() ?? (await importFreighterApi());
    if (!detected) {
      throw new WalletError(
        "not_installed",
        this.id,
        "Freighter was not found. Install the browser extension or pass its API via new FreighterAdapter({ api })."
      );
    }
    this.api = detected;
    return detected;
  }

  private async readNetwork(
    api: FreighterApi
  ): Promise<{ network?: string; networkPassphrase?: string }> {
    if (typeof api.getNetwork !== "function") {
      return {
        network: this.options.network,
        networkPassphrase: this.options.networkPassphrase,
      };
    }
    const raw = await api.getNetwork();
    if (typeof raw === "string" && raw.trim() !== "") {
      return { network: raw.trim().toUpperCase() };
    }
    return {
      network: readString(raw, "network") ?? this.options.network,
      networkPassphrase:
        readString(raw, "networkPassphrase", "network_passphrase") ??
        this.options.networkPassphrase,
    };
  }

  private wrapFailure(error: unknown, action: string): WalletError {
    if (error instanceof WalletError) return error;
    const message = readErrorMessage(error);
    return new WalletError(
      isRejectionMessage(message) ? "rejected" : "sign_failed",
      this.id,
      `Freighter failed during ${action}: ${message ?? "unknown error"}`,
      error
    );
  }
}
