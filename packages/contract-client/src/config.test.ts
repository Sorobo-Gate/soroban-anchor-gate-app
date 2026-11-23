import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  Account,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  createClientConfig,
  createNetworkConfig,
  EscrowGateClient,
  MAINNET,
  STANDALONE,
  TESTNET,
  validateClientConfig,
  validateNetworkConfig,
  type NetworkName,
} from "./index";

const expectedTestnetContractId =
  "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT";

describe("network configuration", () => {
  test("presets use canonical SDK passphrases and the correct RPC endpoints", () => {
    assert.equal(TESTNET.network, "testnet");
    assert.equal(TESTNET.networkPassphrase, Networks.TESTNET);
    assert.equal(TESTNET.rpcUrl, "https://soroban-testnet.stellar.org");
    assert.equal(TESTNET.contractId, expectedTestnetContractId);

    assert.equal(MAINNET.network, "mainnet");
    assert.equal(MAINNET.networkPassphrase, Networks.PUBLIC);
    assert.equal(MAINNET.rpcUrl, "https://mainnet.sorobanrpc.com");
    assert.equal("contractId" in MAINNET, false);

    assert.equal(STANDALONE.network, "standalone");
    assert.equal(STANDALONE.networkPassphrase, Networks.STANDALONE);
    assert.equal(STANDALONE.rpcUrl, "http://localhost:8000/soroban/rpc");
    assert.equal(STANDALONE.networkPassphrase, "Standalone Network ; February 2017");
    assert.notEqual(STANDALONE.networkPassphrase, Networks.FUTURENET);
    assert.equal("contractId" in STANDALONE, false);

    for (const config of [TESTNET, MAINNET, STANDALONE]) {
      assert.ok(Object.isFrozen(config));
      assert.doesNotThrow(() => validateNetworkConfig(config));
    }
  });

  test("custom RPC overrides preserve identity and passphrase without mutation", () => {
    const testnetA = createNetworkConfig("testnet", {
      rpcUrl: "http://127.0.0.1:8000/soroban/rpc",
    });
    const testnetB = createNetworkConfig("testnet", {
      rpcUrl: "https://rpc.example.test/soroban/rpc?token=test-key",
    });
    const standalone = createNetworkConfig("standalone", {
      rpcUrl: "http://localhost:9000/soroban/rpc",
    });

    assert.equal(testnetA.network, "testnet");
    assert.equal(testnetA.rpcUrl, "http://127.0.0.1:8000/soroban/rpc");
    assert.equal(testnetA.networkPassphrase, Networks.TESTNET);
    assert.equal(testnetA.contractId, expectedTestnetContractId);
    assert.equal(testnetB.rpcUrl, "https://rpc.example.test/soroban/rpc?token=test-key");
    assert.equal(testnetB.networkPassphrase, Networks.TESTNET);
    assert.notStrictEqual(testnetA, testnetB);
    assert.notStrictEqual(testnetA, TESTNET);
    assert.equal(standalone.networkPassphrase, Networks.STANDALONE);
    assert.equal(standalone.rpcUrl, "http://localhost:9000/soroban/rpc");
    assert.equal(TESTNET.rpcUrl, "https://soroban-testnet.stellar.org");
    assert.equal(TESTNET.networkPassphrase, Networks.TESTNET);
    assert.ok(Object.isFrozen(testnetA));
  });

  test("client config requires an explicit ID when a preset has no deployment", () => {
    const testnetClientConfig = createClientConfig(TESTNET);
    assert.equal(testnetClientConfig.contractId, expectedTestnetContractId);
    assert.equal(testnetClientConfig.network, "testnet");
    assert.equal(testnetClientConfig.networkPassphrase, Networks.TESTNET);

    assert.throws(() => createClientConfig(MAINNET), /contract ID is required/i);
    assert.throws(() => createClientConfig(STANDALONE), /contract ID is required/i);

    const customMainnetId = StrKey.encodeContract(Buffer.alloc(32, 7));
    const mainnetClientConfig = createClientConfig(MAINNET, customMainnetId);
    assert.equal(mainnetClientConfig.contractId, customMainnetId);
    assert.equal(mainnetClientConfig.network, "mainnet");
    assert.equal(mainnetClientConfig.networkPassphrase, Networks.PUBLIC);
  });

  test("network-specific transaction builders use the selected passphrase", () => {
    const configs = [TESTNET, MAINNET, STANDALONE] as const;
    const sourcePublicKey = Keypair.random().publicKey();

    for (const [index, networkConfig] of configs.entries()) {
      const contractId = StrKey.encodeContract(Buffer.alloc(32, index + 1));
      const client = new EscrowGateClient(
        createClientConfig(networkConfig, contractId)
      );
      const sourceAccount = new Account(sourcePublicKey, "11");
      const transaction = client
        .createTransactionBuilder(sourceAccount)
        .addOperation(client.buildOperation("get_counter", []))
        .setTimeout(30)
        .build();
      const decoded = TransactionBuilder.fromXDR(
        transaction.toXDR(),
        networkConfig.networkPassphrase
      );

      assert.equal(transaction.networkPassphrase, networkConfig.networkPassphrase);
      assert.equal(decoded.networkPassphrase, networkConfig.networkPassphrase);
      assert.equal(transaction.operations.length, 1);

      const wrongPassphrase =
        networkConfig.networkPassphrase === Networks.TESTNET
          ? Networks.PUBLIC
          : Networks.TESTNET;
      const decodedForWrongNetwork = TransactionBuilder.fromXDR(
        transaction.toXDR(),
        wrongPassphrase
      );
      assert.notEqual(
        Buffer.from(transaction.hash()).toString("hex"),
        Buffer.from(decodedForWrongNetwork.hash()).toString("hex")
      );
    }
  });

  test("changing the RPC URL cannot change or mismatch the selected network", () => {
    const config = createNetworkConfig("mainnet", {
      rpcUrl: "https://custom-mainnet.example/rpc",
    });
    const clientConfig = createClientConfig(
      config,
      StrKey.encodeContract(Buffer.alloc(32, 8))
    );
    const client = new EscrowGateClient(clientConfig);

    assert.equal(client.config.rpcUrl, "https://custom-mainnet.example/rpc");
    assert.equal(client.config.network, "mainnet");
    assert.equal(client.config.networkPassphrase, Networks.PUBLIC);
    assert.throws(
      () =>
        validateClientConfig({
          ...clientConfig,
          networkPassphrase: Networks.TESTNET,
        }),
      /does not match/i
    );
  });

  test("rejects malformed URLs, unsupported networks, and unsafe overrides", () => {
    for (const rpcUrl of [
      "",
      "not a URL",
      "http//missing-colon.example",
      "ftp://rpc.example.test",
      " https://rpc.example.test",
      "javascript:alert(1)",
    ]) {
      assert.throws(() => createNetworkConfig("testnet", { rpcUrl }));
    }

    assert.throws(
      () => createNetworkConfig("futurenet" as NetworkName),
      /unsupported stellar network/i
    );
    assert.throws(
      () =>
        createNetworkConfig("testnet", {
          networkPassphrase: Networks.PUBLIC,
        } as never),
      /override 'networkPassphrase' is not supported/i
    );
    assert.throws(
      () =>
        createNetworkConfig("testnet", {
          network: "mainnet",
        } as never),
      /override 'network' is not supported/i
    );
    assert.throws(
      () => createNetworkConfig("testnet", { contractId: "not-a-contract" }),
      /valid stellar contract ID/i
    );
    assert.throws(
      () => createClientConfig(MAINNET, "not-a-contract"),
      /valid contract ID/i
    );
    assert.throws(
      () => createClientConfig(TESTNET, null as never),
      /valid contract ID/i
    );
  });

  test("validates malformed network and missing client configurations", () => {
    assert.throws(() => validateNetworkConfig(null), /must be an object/i);
    assert.throws(
      () =>
        validateNetworkConfig({
          ...MAINNET,
          network: "private",
        }),
      /unsupported stellar network/i
    );
    assert.throws(
      () =>
        validateNetworkConfig({
          ...STANDALONE,
          networkPassphrase: Networks.FUTURENET,
        }),
      /does not match/i
    );
    assert.throws(() => validateClientConfig(undefined as never), /required/i);
    assert.throws(() => createNetworkConfig("testnet", null as never));
  });

  test("legacy client configs remain valid without a network identity", () => {
    const legacyConfig = {
      contractId: expectedTestnetContractId,
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: Networks.TESTNET,
    };

    assert.doesNotThrow(() => validateClientConfig(legacyConfig));
    assert.equal(new EscrowGateClient(legacyConfig).config.network, undefined);
  });
});
