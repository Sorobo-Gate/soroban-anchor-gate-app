import assert from "node:assert";
import { describe, test } from "node:test";
import {
  DEFAULT_TESTNET_CONTRACT_ID,
  validateContractId,
  validateNetworkPassphrase,
  validateRpcUrl,
  getAppConfig,
} from "./config";

describe("Application Configuration Validation", () => {
  test("validateContractId accepts valid C... StrKey contract address", () => {
    const valid = validateContractId(DEFAULT_TESTNET_CONTRACT_ID);
    assert.strictEqual(valid, DEFAULT_TESTNET_CONTRACT_ID);
  });

  test("validateContractId throws on empty, missing, or invalid contract ID", () => {
    assert.throws(() => validateContractId(""), /Contract ID is required/);
    assert.throws(() => validateContractId(undefined), /Contract ID is required/);
    assert.throws(
      () => validateContractId("INVALID_CONTRACT_ID"),
      /Invalid contract ID format/
    );
  });

  test("validateNetworkPassphrase enforces non-empty passphrase", () => {
    const valid = validateNetworkPassphrase("Test SDF Network ; September 2015");
    assert.strictEqual(valid, "Test SDF Network ; September 2015");
    assert.throws(
      () => validateNetworkPassphrase(""),
      /Stellar network passphrase is required/
    );
  });

  test("validateRpcUrl requires valid http/https prefix", () => {
    const valid = validateRpcUrl("https://soroban-testnet.stellar.org");
    assert.strictEqual(valid, "https://soroban-testnet.stellar.org");
    assert.throws(() => validateRpcUrl("invalid-url"), /Invalid Soroban RPC URL/);
  });

  test("getAppConfig returns configured parameters with default fallbacks", () => {
    const config = getAppConfig();
    assert.strictEqual(config.contractId, DEFAULT_TESTNET_CONTRACT_ID);
    assert.strictEqual(config.rpcUrl, "https://soroban-testnet.stellar.org");
    assert.strictEqual(
      config.networkPassphrase,
      "Test SDF Network ; September 2015"
    );
  });
});
