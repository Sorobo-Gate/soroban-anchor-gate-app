import assert from "node:assert";
import { describe, test } from "node:test";
import {
  Keypair,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { buildUnsignedXDR } from "./batch";
import {
  AlbedoAdapter,
  FreighterAdapter,
  MockWalletAdapter,
  WalletError,
  XBullAdapter,
  isWalletError,
} from "./wallets";
import { readErrorMessage } from "./wallets/types";
import type {
  AlbedoProvider,
  FreighterApi,
  WalletErrorCode,
  WalletSignOptions,
  XBullSdk,
} from "./wallets";

const contractId =
  "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function unsignedXDR(sourceAccount: string): string {
  return buildUnsignedXDR({
    sourceAccount,
    sequence: "4294967296",
    contractId,
    method: "get_escrow",
    args: [nativeToScVal(1n, { type: "u64" })],
    networkPassphrase: TESTNET_PASSPHRASE,
  });
}

function signOptions(overrides: Partial<WalletSignOptions> = {}): WalletSignOptions {
  return { networkPassphrase: TESTNET_PASSPHRASE, ...overrides };
}

async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject, but it resolved.");
}

async function expectWalletError(
  fn: () => Promise<unknown>,
  code: WalletErrorCode
): Promise<WalletError> {
  const error = await capture(fn);
  if (!(error instanceof WalletError)) {
    throw new Error(`expected a WalletError, got ${String(error)}`);
  }
  assert.equal(error.code, code);
  return error;
}

describe("WalletError", () => {
  test("carries a category, wallet id, and cause", () => {
    const cause = new Error("extension crashed");
    const error = new WalletError("sign_failed", "freighter", "boom", cause);
    assert.equal(error.name, "WalletError");
    assert.equal(error.code, "sign_failed");
    assert.equal(error.wallet, "freighter");
    assert.equal(error.cause, cause);
    assert.equal(readErrorMessage(error), "boom");
  });
});

describe("MockWalletAdapter", () => {
  test("connects and exposes a deterministic address", async () => {
    const keypair = Keypair.random();
    const wallet = new MockWalletAdapter({ keypair });

    assert.equal(await wallet.isAvailable(), true);
    const connection = await wallet.connect();
    assert.equal(connection.address, keypair.publicKey());
    assert.equal(await wallet.getAddress(), keypair.publicKey());
    assert.equal(wallet.address, keypair.publicKey());
  });

  test("requires connect before reading the address or signing", async () => {
    const wallet = new MockWalletAdapter();
    await expectWalletError(() => wallet.getAddress(), "not_connected");
    await expectWalletError(
      () => wallet.signTransaction(unsignedXDR(wallet.address), signOptions()),
      "not_connected"
    );
  });

  test("signs a real envelope that verifies against its keypair", async () => {
    const keypair = Keypair.random();
    const wallet = new MockWalletAdapter({ keypair });
    await wallet.connect();

    const unsigned = unsignedXDR(keypair.publicKey());
    const signed = await wallet.signTransaction(unsigned, signOptions());

    assert.notEqual(signed, unsigned);
    const transaction = TransactionBuilder.fromXDR(
      signed,
      TESTNET_PASSPHRASE
    );
    assert.equal(transaction.signatures.length, 1);

    const signature = transaction.signatures[0].signature;
    assert.equal(
      keypair.verify(transaction.hash(), signature),
      true,
      "the mock wallet must produce a valid Stellar signature"
    );
  });

  test("supports the network passphrase configured on the adapter", async () => {
    const wallet = new MockWalletAdapter({
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    await wallet.connect();
    const signed = await wallet.signTransaction(
      unsignedXDR(wallet.address),
      { networkPassphrase: TESTNET_PASSPHRASE }
    );
    assert.ok(signed.length > 0);
  });

  test("simulates a rejection", async () => {
    const wallet = new MockWalletAdapter({ rejectSigning: true });
    await wallet.connect();
    const error = await expectWalletError(
      () =>
        wallet.signTransaction(unsignedXDR(wallet.address), signOptions()),
      "rejected"
    );
    assert.match(error.message, /rejected/i);
  });

  test("rejects signing for an address it does not control", async () => {
    const wallet = new MockWalletAdapter();
    await wallet.connect();
    await expectWalletError(
      () =>
        wallet.signTransaction(unsignedXDR(wallet.address), signOptions({
          address: Keypair.random().publicKey(),
        })),
      "network_mismatch"
    );
  });

  test("rejects malformed envelopes", async () => {
    const wallet = new MockWalletAdapter();
    await wallet.connect();
    await expectWalletError(
      () => wallet.signTransaction("not-an-envelope", signOptions()),
      "invalid_request"
    );
    await expectWalletError(
      () => wallet.signTransaction("", signOptions()),
      "invalid_request"
    );
  });

  test("requires a network passphrase", async () => {
    const wallet = new MockWalletAdapter();
    await wallet.connect();
    await expectWalletError(
      () =>
        wallet.signTransaction(unsignedXDR(wallet.address), {
          networkPassphrase: " ",
        }),
      "invalid_request"
    );
  });

  test("can simulate an unavailable wallet", async () => {
    const wallet = new MockWalletAdapter({ unavailable: true });
    assert.equal(await wallet.isAvailable(), false);
    await expectWalletError(() => wallet.connect(), "not_installed");
  });

  test("disconnect revokes access", async () => {
    const wallet = new MockWalletAdapter();
    await wallet.connect();
    await wallet.disconnect?.();
    await expectWalletError(() => wallet.getAddress(), "not_connected");
  });
});

function freighterApi(overrides: Partial<FreighterApi> = {}): FreighterApi {
  const address = Keypair.random().publicKey();
  return {
    isConnected: async () => true,
    requestAccess: async () => ({ address }),
    getAddress: async () => ({ address }),
    getNetwork: async () => ({
      network: "TESTNET",
      networkPassphrase: TESTNET_PASSPHRASE,
    }),
    signTransaction: async (xdr: string) => ({ signedTxXdr: xdr }),
    ...overrides,
  };
}

describe("FreighterAdapter", () => {
  test("connects, reads the network, and signs", async () => {
    const api = freighterApi();
    const wallet = new FreighterAdapter({ api });

    assert.equal(wallet.id, "freighter");
    assert.equal(await wallet.isAvailable(), true);

    const connection = await wallet.connect();
    assert.equal(connection.network, "TESTNET");
    assert.equal(connection.networkPassphrase, TESTNET_PASSPHRASE);

    const unsigned = unsignedXDR(connection.address);
    const signed = await wallet.signTransaction(unsigned, signOptions());
    assert.equal(signed, unsigned);
    assert.equal(await wallet.getAddress(), connection.address);
  });

  test("supports Freighter v1 string responses", async () => {
    const address = Keypair.random().publicKey();
    const api: FreighterApi = {
      isConnected: () => true,
      requestAccess: async () => address,
      getAddress: async () => address,
      getNetwork: async () => "PUBLIC",
      signTransaction: (xdr: string) => xdr,
    };
    const wallet = new FreighterAdapter({ api });
    const connection = await wallet.connect();
    assert.equal(connection.address, address);
    assert.equal(connection.network, "PUBLIC");
  });

  test("maps a declined access request to rejected", async () => {
    const api = freighterApi({
      requestAccess: async () => ({ error: "User rejected the request" }),
    });
    const wallet = new FreighterAdapter({ api });
    await expectWalletError(() => wallet.connect(), "rejected");
  });

  test("maps a declined signature to rejected", async () => {
    const api = freighterApi({
      signTransaction: async () => ({ error: "User denied signing" }),
    });
    const wallet = new FreighterAdapter({ api });
    const { address } = await wallet.connect();
    await expectWalletError(
      () => wallet.signTransaction(unsignedXDR(address), signOptions()),
      "rejected"
    );
  });

  test("rejects signing responses without an envelope", async () => {
    const api = freighterApi({ signTransaction: async () => ({}) });
    const wallet = new FreighterAdapter({ api });
    const { address } = await wallet.connect();
    await expectWalletError(
      () => wallet.signTransaction(unsignedXDR(address), signOptions()),
      "malformed_response"
    );
  });

  test("reports not_connected when the extension has no account", async () => {
    const api = freighterApi({
      requestAccess: async () => true,
      getAddress: async () => ({ error: "Freighter is locked" }),
    });
    const wallet = new FreighterAdapter({ api });
    await expectWalletError(() => wallet.connect(), "not_connected");
  });

  test("reports not_installed when no API is available", async () => {
    const wallet = new FreighterAdapter();
    assert.equal(await wallet.isAvailable(), false);
    await expectWalletError(() => wallet.connect(), "not_installed");
  });

  test("validates signing input before contacting the wallet", async () => {
    const wallet = new FreighterAdapter({ api: freighterApi() });
    await wallet.connect();
    await expectWalletError(
      () => wallet.signTransaction("", signOptions()),
      "invalid_request"
    );
  });
});

describe("XBullAdapter", () => {
  function xbullSdk(overrides: Partial<XBullSdk> = {}): XBullSdk {
    const publicKey = Keypair.random().publicKey();
    return {
      connect: async () => ({ publicKey }),
      getPublicKey: async () => publicKey,
      signXDR: async (xdr: string) => ({ signedXDR: xdr }),
      ...overrides,
    };
  }

  test("connects and signs through signXDR", async () => {
    const wallet = new XBullAdapter({ sdk: xbullSdk() });
    assert.equal(wallet.id, "xbull");
    assert.equal(await wallet.isAvailable(), true);
    const { address } = await wallet.connect();
    const signed = await wallet.signTransaction(
      unsignedXDR(address),
      signOptions()
    );
    assert.ok(signed.length > 0);
  });

  test("falls back to the legacy sign method", async () => {
    const publicKey = Keypair.random().publicKey();
    const wallet = new XBullAdapter({
      sdk: {
        getPublicKey: async () => publicKey,
        sign: async (xdr: string) => xdr,
      },
    });
    await wallet.connect();
    const signed = await wallet.signTransaction(
      unsignedXDR(publicKey),
      signOptions()
    );
    assert.equal(signed.length > 0, true);
  });

  test("maps rejections and malformed responses", async () => {
    const rejected = new XBullAdapter({
      sdk: xbullSdk({
        signXDR: async () => ({ error: "Request cancelled by user" }),
      }),
    });
    const { address } = await rejected.connect();
    await expectWalletError(
      () => rejected.signTransaction(unsignedXDR(address), signOptions()),
      "rejected"
    );

    const malformed = new XBullAdapter({ sdk: xbullSdk({ signXDR: async () => ({}) }) });
    const connected = await malformed.connect();
    await expectWalletError(
      () => malformed.signTransaction(unsignedXDR(connected.address), signOptions()),
      "malformed_response"
    );
  });

  test("reports not_installed without a global SDK", async () => {
    const wallet = new XBullAdapter();
    assert.equal(await wallet.isAvailable(), false);
    await expectWalletError(() => wallet.connect(), "not_installed");
  });
});

describe("AlbedoAdapter", () => {
  function albedoProvider(overrides: Partial<AlbedoProvider> = {}): AlbedoProvider {
    const pubkey = Keypair.random().publicKey();
    return {
      publicKey: async () => ({ pubkey }),
      tx: async (params) => ({ signed_envelope_xdr: params.xdr }),
      ...overrides,
    };
  }

  test("connects and signs with the derived network", async () => {
    let seenNetwork: string | undefined;
    const publicKey = Keypair.random().publicKey();
    const wallet = new AlbedoAdapter({
      provider: {
        publicKey: async () => ({ pubkey: publicKey }),
        tx: async (params) => {
          seenNetwork = params.network;
          return { signed_envelope_xdr: params.xdr };
        },
      },
    });
    assert.equal(wallet.id, "albedo");
    assert.equal(await wallet.isAvailable(), true);

    const { address } = await wallet.connect();
    assert.equal(address, publicKey);
    const signed = await wallet.signTransaction(
      unsignedXDR(address),
      signOptions()
    );
    assert.equal(seenNetwork, "testnet");
    assert.ok(signed.length > 0);
  });

  test("maps mainnet passphrases to Albedo's public network", async () => {
    let seenNetwork: string | undefined;
    const wallet = new AlbedoAdapter({
      provider: albedoProvider({
        tx: async (params) => {
          seenNetwork = params.network;
          return { signed_envelope_xdr: params.xdr };
        },
      }),
    });
    const { address } = await wallet.connect();
    await wallet.signTransaction(unsignedXDR(address), {
      networkPassphrase: "Public Global Stellar Network ; September 2015",
    });
    assert.equal(seenNetwork, "public");
  });

  test("accepts a plain signed envelope string", async () => {
    const wallet = new AlbedoAdapter({
      provider: albedoProvider({ tx: async (params) => params.xdr }),
    });
    const { address } = await wallet.connect();
    const signed = await wallet.signTransaction(
      unsignedXDR(address),
      signOptions()
    );
    assert.ok(signed.length > 0);
  });

  test("rejects malformed public key responses", async () => {
    const wallet = new AlbedoAdapter({
      provider: albedoProvider({ publicKey: async () => ({}) }),
    });
    await expectWalletError(() => wallet.connect(), "malformed_response");
  });

  test("maps a declined signing request to rejected", async () => {
    const wallet = new AlbedoAdapter({
      provider: albedoProvider({
        tx: async () => ({ error: "User denied the request" }),
      }),
    });
    const { address } = await wallet.connect();
    await expectWalletError(
      () => wallet.signTransaction(unsignedXDR(address), signOptions()),
      "rejected"
    );
  });

  test("reports not_installed without a global provider", async () => {
    const wallet = new AlbedoAdapter();
    assert.equal(await wallet.isAvailable(), false);
    await expectWalletError(() => wallet.connect(), "not_installed");
  });
});
