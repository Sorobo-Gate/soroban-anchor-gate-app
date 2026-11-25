/**
 * Deterministic mock wallet for headless tests and server-side flows.
 *
 * The mock signs real Stellar envelopes with an in-memory {@link Keypair}, so
 * tests exercise the same XDR round-trip a browser wallet performs without
 * installing an extension. Failures can be simulated with `rejectSigning`.
 *
 * @example
 * ```ts
 * const wallet = new MockWalletAdapter({ networkPassphrase: TESTNET });
 * const { address } = await wallet.connect();
 * const signed = await wallet.signTransaction(unsignedXDR, {
 *   networkPassphrase: TESTNET,
 * });
 * ```
 *
 * @packageDocumentation
 */

import {
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  WalletError,
  assertSignRequest,
  readErrorMessage,
} from "./types";
import type {
  WalletAdapter,
  WalletConnection,
  WalletId,
  WalletSignOptions,
} from "./types";

/** Construction options for {@link MockWalletAdapter}. */
export interface MockWalletAdapterOptions {
  /** Keypair used to sign; a random one is generated when omitted. */
  keypair?: Keypair;
  /** Network passphrase reported by `connect` and used when signing. */
  networkPassphrase?: string;
  /** Simulate a user rejection on every `signTransaction` call. */
  rejectSigning?: boolean;
  /** Simulate a wallet that cannot be reached. */
  unavailable?: boolean;
}

/**
 * In-memory wallet adapter that signs with a real Stellar keypair.
 */
export class MockWalletAdapter implements WalletAdapter {
  /** Stable adapter identifier. */
  public readonly id: WalletId = "mock";

  /** Human-readable wallet name. */
  public readonly name = "Mock Wallet";

  private readonly options: MockWalletAdapterOptions;

  private readonly keypair: Keypair;

  private connected = false;

  constructor(options: MockWalletAdapterOptions = {}) {
    this.options = options;
    this.keypair = options.keypair ?? Keypair.random();
  }

  /**
   * Returns the address the mock will sign with, for test assertions.
   */
  public get address(): string {
    return this.keypair.publicKey();
  }

  /** The mock is available unless constructed as `unavailable`. */
  public async isAvailable(): Promise<boolean> {
    return this.options.unavailable !== true;
  }

  /**
   * Marks the wallet as connected.
   *
   * @throws {WalletError} With code `not_installed` when constructed as
   *   `unavailable`.
   */
  public async connect(): Promise<WalletConnection> {
    if (this.options.unavailable) {
      throw new WalletError(
        "not_installed",
        this.id,
        "The mock wallet was constructed as unavailable."
      );
    }
    this.connected = true;
    return {
      address: this.keypair.publicKey(),
      networkPassphrase: this.options.networkPassphrase,
    };
  }

  /**
   * Returns the signing address.
   *
   * @throws {WalletError} With code `not_connected` before `connect()`.
   */
  public async getAddress(): Promise<string> {
    if (!this.connected) {
      throw new WalletError(
        "not_connected",
        this.id,
        "The mock wallet is not connected. Call connect() first."
      );
    }
    return this.keypair.publicKey();
  }

  /**
   * Signs a base64 transaction envelope with the mock keypair.
   *
   * @param xdr - Base64 envelope produced by `buildUnsignedXDR`.
   * @param options - Network passphrase and optional expected address.
   * @returns The base64 signed envelope.
   * @throws {WalletError} When disconnected, when signing is configured to be
   *   rejected, when the requested address does not match, or when the input is
   *   not a single transaction envelope.
   */
  public async signTransaction(
    xdr: string,
    options: WalletSignOptions
  ): Promise<string> {
    assertSignRequest(this.id, xdr, options);
    if (!this.connected) {
      throw new WalletError(
        "not_connected",
        this.id,
        "The mock wallet is not connected. Call connect() first."
      );
    }
    if (this.options.rejectSigning) {
      throw new WalletError(
        "rejected",
        this.id,
        "The mock wallet rejected the signing request."
      );
    }
    if (options.address && options.address !== this.keypair.publicKey()) {
      throw new WalletError(
        "network_mismatch",
        this.id,
        `The mock wallet controls ${this.keypair.publicKey()}, not ${options.address}.`
      );
    }

    const passphrase =
      options.networkPassphrase ?? this.options.networkPassphrase;
    if (!passphrase || passphrase.trim() === "") {
      throw new WalletError(
        "invalid_request",
        this.id,
        "A network passphrase is required to sign the transaction."
      );
    }

    let envelope: ReturnType<typeof TransactionBuilder.fromXDR>;
    try {
      envelope = TransactionBuilder.fromXDR(xdr, passphrase);
    } catch (error) {
      throw new WalletError(
        "invalid_request",
        this.id,
        `The transaction XDR could not be decoded: ${
          readErrorMessage(error) ?? "invalid base64 envelope"
        }`,
        error
      );
    }

    if (envelope instanceof FeeBumpTransaction) {
      throw new WalletError(
        "invalid_request",
        this.id,
        "The mock wallet does not sign fee-bump envelopes; pass the inner transaction instead."
      );
    }

    envelope.sign(this.keypair);
    return envelope.toXDR();
  }

  /** Marks the wallet as disconnected. */
  public async disconnect(): Promise<void> {
    this.connected = false;
  }
}
