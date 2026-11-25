import assert from "node:assert";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NetworkMismatchModal,
  WALLET_SESSION_STORAGE_KEY,
  WalletProvider,
  clearWalletSession,
  describeNetwork,
  isWalletNetworkMismatch,
  isValidWalletAddress,
  readWalletSession,
  useWallet,
  writeWalletSession,
  type StorageLike,
  type WalletSession,
} from "../components/WalletProvider";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const WALLET_ADDRESS =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const THROWING_STORAGE: StorageLike = {
  getItem() {
    throw new Error("storage blocked");
  },
  setItem() {
    throw new Error("storage blocked");
  },
  removeItem() {
    throw new Error("storage blocked");
  },
};

function session(overrides: Partial<WalletSession> = {}): WalletSession {
  return {
    address: WALLET_ADDRESS,
    networkPassphrase: TESTNET_PASSPHRASE,
    connectedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("Wallet session persistence", () => {
  test("round-trips a wallet session through storage", () => {
    const storage = new MemoryStorage();
    assert.strictEqual(writeWalletSession(storage, session()), true);

    assert.deepStrictEqual(readWalletSession(storage), session());
    assert.ok(storage.getItem(WALLET_SESSION_STORAGE_KEY));
  });

  test("trims the stored wallet address", () => {
    const storage = new MemoryStorage();
    writeWalletSession(storage, session({ address: `  ${WALLET_ADDRESS}  ` }));

    assert.strictEqual(readWalletSession(storage)?.address, WALLET_ADDRESS);
  });

  test("returns null when no session is stored", () => {
    assert.strictEqual(readWalletSession(new MemoryStorage()), null);
    assert.strictEqual(readWalletSession(null), null);
    assert.strictEqual(readWalletSession(undefined), null);
  });

  test("rejects malformed JSON and non-object payloads", () => {
    for (const raw of ["{not json", "null", "42", '"address"', "[]"]) {
      const storage = new MemoryStorage();
      storage.setItem(WALLET_SESSION_STORAGE_KEY, raw);
      assert.strictEqual(readWalletSession(storage), null, raw);
    }
  });

  test("rejects invalid or missing wallet addresses", () => {
    for (const address of ["", "G123", "not-a-wallet", "gbd47if"]) {
      const storage = new MemoryStorage();
      storage.setItem(
        WALLET_SESSION_STORAGE_KEY,
        JSON.stringify({ address, connectedAt: 1 })
      );
      assert.strictEqual(readWalletSession(storage), null, address);
    }
  });

  test("normalises missing or invalid optional metadata", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      WALLET_SESSION_STORAGE_KEY,
      JSON.stringify({
        address: WALLET_ADDRESS,
        networkPassphrase: 123,
        connectedAt: "yesterday",
      })
    );

    assert.deepStrictEqual(readWalletSession(storage), {
      address: WALLET_ADDRESS,
      networkPassphrase: undefined,
      connectedAt: 0,
    });
  });

  test("refuses to write invalid sessions or use missing storage", () => {
    const storage = new MemoryStorage();
    assert.strictEqual(
      writeWalletSession(storage, session({ address: "invalid" })),
      false
    );
    assert.strictEqual(writeWalletSession(null, session()), false);
    assert.strictEqual(storage.values.size, 0);
  });

  test("clears a stored session", () => {
    const storage = new MemoryStorage();
    writeWalletSession(storage, session());
    clearWalletSession(storage);

    assert.strictEqual(storage.getItem(WALLET_SESSION_STORAGE_KEY), null);
    assert.strictEqual(readWalletSession(storage), null);
  });

  test("degrades gracefully when storage access throws", () => {
    assert.strictEqual(readWalletSession(THROWING_STORAGE), null);
    assert.strictEqual(writeWalletSession(THROWING_STORAGE, session()), false);
    assert.doesNotThrow(() => clearWalletSession(THROWING_STORAGE));
  });

  test("validates Stellar ed25519 public keys", () => {
    assert.strictEqual(isValidWalletAddress(WALLET_ADDRESS), true);
    assert.strictEqual(isValidWalletAddress(`  ${WALLET_ADDRESS}  `), true);
    assert.strictEqual(isValidWalletAddress(WALLET_ADDRESS.toLowerCase()), false);
    assert.strictEqual(isValidWalletAddress("GABC"), false);
    assert.strictEqual(isValidWalletAddress("SBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"), false);
    assert.strictEqual(isValidWalletAddress(""), false);
    assert.strictEqual(isValidWalletAddress(null), false);
    assert.strictEqual(isValidWalletAddress(undefined), false);
    assert.strictEqual(isValidWalletAddress(42), false);
  });
});

describe("Wallet network mismatch guard", () => {
  test("detects a Mainnet wallet while the app expects Testnet", () => {
    assert.strictEqual(
      isWalletNetworkMismatch(
        { networkPassphrase: MAINNET_PASSPHRASE },
        TESTNET_PASSPHRASE
      ),
      true
    );
  });

  test("accepts the expected passphrase with surrounding whitespace", () => {
    assert.strictEqual(
      isWalletNetworkMismatch(
        { networkPassphrase: `  ${TESTNET_PASSPHRASE}  ` },
        TESTNET_PASSPHRASE
      ),
      false
    );
  });

  test("falls back to the network name when no passphrase is returned", () => {
    assert.strictEqual(
      isWalletNetworkMismatch(
        { network: MAINNET_PASSPHRASE },
        TESTNET_PASSPHRASE
      ),
      true
    );
  });

  test("does not report a mismatch when details are unavailable", () => {
    assert.strictEqual(isWalletNetworkMismatch(null, TESTNET_PASSPHRASE), false);
    assert.strictEqual(isWalletNetworkMismatch(undefined, TESTNET_PASSPHRASE), false);
    assert.strictEqual(isWalletNetworkMismatch({}, TESTNET_PASSPHRASE), false);
    assert.strictEqual(
      isWalletNetworkMismatch(
        { networkPassphrase: "   " },
        TESTNET_PASSPHRASE
      ),
      false
    );
  });

  test("does not report a mismatch when no expected passphrase is set", () => {
    assert.strictEqual(
      isWalletNetworkMismatch({ networkPassphrase: MAINNET_PASSPHRASE }, ""),
      false
    );
  });

  test("describes well-known Stellar networks", () => {
    assert.strictEqual(describeNetwork(TESTNET_PASSPHRASE), "Stellar Testnet");
    assert.strictEqual(describeNetwork(MAINNET_PASSPHRASE), "Stellar Mainnet");
    assert.strictEqual(
      describeNetwork("Test SDF Future Network ; October 2022"),
      "Stellar Futurenet"
    );
    assert.strictEqual(
      describeNetwork("Standalone Network ; February 2017"),
      "Stellar Standalone"
    );
    assert.strictEqual(describeNetwork("Some private chain"), "a custom Stellar network");
  });
});

describe("WalletProvider context", () => {
  function Probe() {
    const wallet = useWallet();
    return React.createElement(
      "output",
      { "data-testid": "wallet-probe" },
      [
        wallet.isConnected ? "connected" : "disconnected",
        wallet.address ?? "no-address",
        wallet.isConnecting ? "connecting" : "idle",
        wallet.expectedNetworkPassphrase,
        wallet.networkMismatch ? "mismatch" : "network-ok",
        wallet.detectedNetworkPassphrase ?? "no-network",
        wallet.error ?? "no-error",
      ].join("|")
    );
  }

  test("provides a stable disconnected context before reconnection runs", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        WalletProvider,
        {
          expectedNetworkPassphrase: TESTNET_PASSPHRASE,
          storage: new MemoryStorage(),
        },
        React.createElement(Probe)
      )
    );

    assert.ok(html.includes('data-testid="wallet-probe"'));
    assert.ok(
      html.includes(
        `disconnected|no-address|idle|${TESTNET_PASSPHRASE}|network-ok|no-network|no-error`
      ),
      html
    );
    assert.ok(!html.includes('data-testid="network-mismatch-modal"'));
  });

  test("renders children even when no storage backend is available", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        WalletProvider,
        { expectedNetworkPassphrase: TESTNET_PASSPHRASE, storage: null },
        React.createElement("p", null, "dashboard child")
      )
    );

    assert.ok(html.includes("dashboard child"));
  });

  test("useWallet throws a clear error outside the provider", () => {
    assert.throws(
      () => renderToStaticMarkup(React.createElement(Probe)),
      /useWallet must be used within a WalletProvider/
    );
  });
});

describe("NetworkMismatchModal", () => {
  test("renders a prominent, accessible mismatch warning", () => {
    const html = renderToStaticMarkup(
      React.createElement(NetworkMismatchModal, {
        expectedNetworkPassphrase: TESTNET_PASSPHRASE,
        detectedNetworkPassphrase: MAINNET_PASSPHRASE,
        onRetry: () => undefined,
        onDismiss: () => undefined,
      })
    );

    assert.ok(html.includes('data-testid="network-mismatch-modal"'));
    assert.ok(html.includes('role="alertdialog"'));
    assert.ok(html.includes('aria-modal="true"'));
    assert.ok(html.includes("Wrong Freighter network"));
    assert.ok(html.includes("Stellar Mainnet"));
    assert.ok(html.includes("Stellar Testnet"));
    assert.ok(html.includes(`Expected passphrase: ${TESTNET_PASSPHRASE}`));
    assert.ok(html.includes("Switch to Stellar Testnet"));
    assert.ok(html.includes("Dismiss"));
  });

  test("shows the retrying state on the switch button", () => {
    const html = renderToStaticMarkup(
      React.createElement(NetworkMismatchModal, {
        expectedNetworkPassphrase: TESTNET_PASSPHRASE,
        detectedNetworkPassphrase: MAINNET_PASSPHRASE,
        onRetry: () => undefined,
        onDismiss: () => undefined,
        isRetrying: true,
      })
    );

    assert.ok(html.includes("Checking network..."));
    assert.ok(html.includes('disabled=""'));
  });

  test("handles an unknown detected network without crashing", () => {
    const html = renderToStaticMarkup(
      React.createElement(NetworkMismatchModal, {
        expectedNetworkPassphrase: TESTNET_PASSPHRASE,
        detectedNetworkPassphrase: null,
        onRetry: () => undefined,
        onDismiss: () => undefined,
      })
    );

    assert.ok(html.includes("an unknown network"));
  });
});
