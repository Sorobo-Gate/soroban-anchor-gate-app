import assert from "node:assert";
import { test, describe } from "node:test";
import {
  EscrowGateClient,
  EscrowContractState,
  computeProfileHash,
  formatTokenAmount,
  isValidAddress,
  parseTokenAmount,
  validateClientConfig,
  validateProfileHashHex,
} from "./index";
import { Keypair, scValToNative } from "@stellar/stellar-sdk";

describe("EscrowGateClient & SDK Helpers", () => {
  const validContractId = "CCCSLE7UN2FRLB2HQWEUEXM4365NDYH3QSC6J5TILQWBSTTIDKFWXX2Y";
  const validPayer = Keypair.random().publicKey();
  const validBeneficiary = Keypair.random().publicKey();
  const validToken = Keypair.random().publicKey();
  const validAnchor = Keypair.random().publicKey();
  const validRpcUrl = "https://soroban-testnet.stellar.org";
  const validPassphrase = "Test SDF Network ; September 2015";

  const validConfig = {
    contractId: validContractId,
    rpcUrl: validRpcUrl,
    networkPassphrase: validPassphrase,
  };

  test("validateClientConfig passes for valid config", () => {
    assert.doesNotThrow(() => validateClientConfig(validConfig));
  });

  test("validateClientConfig throws on invalid contract ID or empty passphrase", () => {
    assert.throws(() =>
      validateClientConfig({ ...validConfig, contractId: "INVALID" })
    );
    assert.throws(() =>
      validateClientConfig({ ...validConfig, networkPassphrase: "" })
    );
    assert.throws(() =>
      validateClientConfig({ ...validConfig, rpcUrl: "invalid-url" })
    );
  });

  test("isValidAddress validates G-addresses and C-addresses", () => {
    assert.strictEqual(isValidAddress(validPayer), true);
    assert.strictEqual(isValidAddress(validContractId), true);
    assert.strictEqual(isValidAddress("INVALID_ADDRESS"), false);
  });

  test("computeProfileHash produces deterministic 32-byte hex hash", () => {
    const rawRouting = "IBAN: DE89370400440532013000";
    const hash1 = computeProfileHash(rawRouting);
    const hash2 = computeProfileHash(rawRouting);

    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 64);
    assert.doesNotThrow(() => validateProfileHashHex(hash1));
  });

  test("validateProfileHashHex rejects invalid hash length or non-hex string", () => {
    assert.throws(() => validateProfileHashHex("12345"));
    assert.throws(() => validateProfileHashHex("z".repeat(64)));
  });

  test("integer-safe token amount parsing and formatting", () => {
    const parsed = parseTokenAmount("100.5", 7);
    assert.strictEqual(parsed, 1005000000n);

    const formatted = formatTokenAmount(1005000000n, 7);
    assert.strictEqual(formatted, "100.5");

    assert.throws(() => parseTokenAmount("100.12345678", 7));
    assert.throws(() => parseTokenAmount("-50", 7));
  });

  test("buildCreateEscrowTx encodes correct argument types and order", () => {
    const client = new EscrowGateClient(validConfig);
    const profileHashHex = computeProfileHash("DE89370400440532013000");

    const args = client.buildCreateEscrowTx({
      payer: validPayer,
      beneficiary: validBeneficiary,
      token: validToken,
      amount: 500000000n,
      profileHashHex,
      lockDurationSeconds: 86400n,
    });

    assert.strictEqual(args.length, 6);
    assert.strictEqual(scValToNative(args[0]), validPayer);
    assert.strictEqual(scValToNative(args[1]), validBeneficiary);
    assert.strictEqual(scValToNative(args[2]), validToken);
    assert.strictEqual(scValToNative(args[3]), 500000000n);
    assert.strictEqual(
      Buffer.from(args[4].bytes()).toString("hex"),
      profileHashHex
    );
    assert.strictEqual(scValToNative(args[5]), 86400n);
  });

  test("buildReleaseToAnchorTx encodes u64 escrow_id and addresses", () => {
    const client = new EscrowGateClient(validConfig);
    const args = client.buildReleaseToAnchorTx({
      escrowId: 42n,
      caller: validPayer,
      anchorDisbursementAddress: validAnchor,
    });

    assert.strictEqual(args.length, 3);
    assert.strictEqual(scValToNative(args[0]), 42n);
    assert.strictEqual(scValToNative(args[1]), validPayer);
    assert.strictEqual(scValToNative(args[2]), validAnchor);
  });

  test("buildRefundTx encodes u64 escrow_id", () => {
    const client = new EscrowGateClient(validConfig);
    const args = client.buildRefundTx(100n);

    assert.strictEqual(args.length, 1);
    assert.strictEqual(scValToNative(args[0]), 100n);
  });

  test("contract state enum match", () => {
    assert.strictEqual(EscrowContractState.Funded, "Funded");
    assert.strictEqual(EscrowContractState.Disbursed, "Disbursed");
    assert.strictEqual(EscrowContractState.Refunded, "Refunded");
  });
});
