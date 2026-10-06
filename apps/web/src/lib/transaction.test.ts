import assert from "node:assert";
import { describe, test } from "node:test";
import { Account, Keypair, Transaction, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import {
  validateEscrowForm,
  verifyWalletNetwork,
  buildEscrowContractCall,
  simulateAndPrepareTransaction,
  submitSignedTransaction,
  pollTransactionConfirmation,
} from "./transaction";
import { hashRoutingInfo } from "./crypto";

describe("Frontend Financial Transaction Flow & Validation", () => {
  const validPayer = Keypair.random().publicKey();
  const validBeneficiary = Keypair.random().publicKey();
  const validContractId =
    "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT";
  const validTokenContract =
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const expectedPassphrase = "Test SDF Network ; September 2015";

  test("validateEscrowForm accepts valid complete inputs", () => {
    const validData = {
      payer: validPayer,
      beneficiary: validBeneficiary,
      token: validTokenContract,
      amount: "100.5",
      lockDurationDays: "7",
      routingInfo: "IBAN: DE89370400440532013000 / BIC: COBADEFFXXX",
    };

    const validated = validateEscrowForm(validData);
    assert.strictEqual(validated.payer, validPayer);
    assert.strictEqual(validated.beneficiary, validBeneficiary);
    assert.strictEqual(validated.token, validTokenContract);
    assert.strictEqual(validated.baseUnitsAmount, 1005000000n);
    assert.strictEqual(validated.lockDurationSeconds, 604800n);
    assert.strictEqual(
      validated.routingInfo,
      "IBAN: DE89370400440532013000 / BIC: COBADEFFXXX"
    );
  });

  test("validateEscrowForm rejects invalid or missing payer wallet", () => {
    assert.throws(
      () =>
        validateEscrowForm({
          payer: "",
          beneficiary: validBeneficiary,
          token: validTokenContract,
          amount: "100",
          lockDurationDays: "7",
          routingInfo: "IBAN: DE123",
        }),
      /Invalid payer wallet address/
    );

    assert.throws(
      () =>
        validateEscrowForm({
          payer: "G_INVALID_ADDRESS",
          beneficiary: validBeneficiary,
          token: validTokenContract,
          amount: "100",
          lockDurationDays: "7",
          routingInfo: "IBAN: DE123",
        }),
      /Invalid payer wallet address/
    );
  });

  test("validateEscrowForm rejects invalid beneficiary", () => {
    assert.throws(
      () =>
        validateEscrowForm({
          payer: validPayer,
          beneficiary: "NOT_A_VALID_BENEFICIARY",
          token: validTokenContract,
          amount: "100",
          lockDurationDays: "7",
          routingInfo: "IBAN: DE123",
        }),
      /Invalid contractor\/beneficiary address/
    );
  });

  test("validateEscrowForm rejects invalid token contract address", () => {
    assert.throws(
      () =>
        validateEscrowForm({
          payer: validPayer,
          beneficiary: validBeneficiary,
          token: validPayer, // G-address instead of C-address
          amount: "100",
          lockDurationDays: "7",
          routingInfo: "IBAN: DE123",
        }),
      /Invalid token contract address/
    );
  });

  test("validateEscrowForm rejects invalid, zero, or negative amount", () => {
    assert.throws(
      () =>
        validateEscrowForm({
          payer: validPayer,
          beneficiary: validBeneficiary,
          token: validTokenContract,
          amount: "0",
          lockDurationDays: "7",
          routingInfo: "IBAN: DE123",
        }),
      /Escrow amount must be strictly greater than zero/
    );

    assert.throws(
      () =>
        validateEscrowForm({
          payer: validPayer,
          beneficiary: validBeneficiary,
          token: validTokenContract,
          amount: "-50",
          lockDurationDays: "7",
          routingInfo: "IBAN: DE123",
        }),
      /Invalid token amount string/
    );
  });

  test("validateEscrowForm rejects invalid lock duration", () => {
    assert.throws(
      () =>
        validateEscrowForm({
          payer: validPayer,
          beneficiary: validBeneficiary,
          token: validTokenContract,
          amount: "100",
          lockDurationDays: "0",
          routingInfo: "IBAN: DE123",
        }),
      /Lock duration must be a positive integer/
    );

    assert.throws(
      () =>
        validateEscrowForm({
          payer: validPayer,
          beneficiary: validBeneficiary,
          token: validTokenContract,
          amount: "100",
          lockDurationDays: "500",
          routingInfo: "IBAN: DE123",
        }),
      /Lock duration must be a positive integer between 1 and 365 days/
    );
  });

  test("verifyWalletNetwork validates network agreement and rejects mismatches", () => {
    // 1. Matches expected passphrase
    assert.doesNotThrow(() =>
      verifyWalletNetwork(
        { networkPassphrase: expectedPassphrase },
        expectedPassphrase
      )
    );

    // 2. Mismatched network (e.g. Public Network)
    assert.throws(
      () =>
        verifyWalletNetwork(
          { networkPassphrase: "Public Global Stellar Network ; September 2015" },
          expectedPassphrase
        ),
      /Wallet network mismatch/
    );

    // 3. Null or undefined details (wallet disconnected)
    assert.throws(
      () => verifyWalletNetwork(null, expectedPassphrase),
      /Unable to verify Freighter wallet network/
    );
  });

  test("buildEscrowContractCall generates invocation with 32-byte profile hash commitment", async () => {
    const rawRouting = "TEST_FIXTURE_BANKING_IBAN_2026";
    const profileHash = await hashRoutingInfo(rawRouting);
    assert.strictEqual(profileHash.length, 64);

    const params = validateEscrowForm({
      payer: validPayer,
      beneficiary: validBeneficiary,
      token: validTokenContract,
      amount: "50.0",
      lockDurationDays: "14",
      routingInfo: rawRouting,
    });

    const op = buildEscrowContractCall(validContractId, params, profileHash);
    assert.strictEqual(op.body.type, "invokeHostFunction");
  });

  test("simulateAndPrepareTransaction handles Soroban host simulation failures", async () => {
    const mockServer = {
      simulateTransaction: async () => ({
        error: "Contract execution trapped: Unauthorized payer",
        minResourceFee: "0",
        events: [],
      }),
    } as unknown as rpc.Server;

    await assert.rejects(
      () => simulateAndPrepareTransaction(mockServer, {} as Transaction),
      /Soroban transaction simulation failed: Contract execution trapped/
    );
  });

  test("submitSignedTransaction throws on RPC submission failure", async () => {
    const mockServer = {
      sendTransaction: async () => ({
        status: "ERROR",
        errorResult: {
          toXDR: () => "tx_bad_auth",
        },
      }),
    } as unknown as rpc.Server;

    const sourceAccount = new Account(validPayer, "100");
    const testTx = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: expectedPassphrase,
    })
      .setTimeout(30)
      .build();

    await assert.rejects(
      () =>
        submitSignedTransaction(
          mockServer,
          testTx.toXDR(),
          expectedPassphrase
        ),
      /Transaction submission failed with RPC error/
    );
  });

  test("pollTransactionConfirmation authoritatively polls until SUCCESS or FAILED", async () => {
    let callCount = 0;
    const mockServer = {
      getTransaction: async () => {
        callCount++;
        if (callCount < 2) {
          return { status: "NOT_FOUND" };
        }
        return {
          status: "SUCCESS",
          latestLedger: 5035999,
          createdAt: 1791203000,
        };
      },
    } as unknown as rpc.Server;

    const result = await pollTransactionConfirmation(
      mockServer,
      "real_tx_hash_12345",
      5,
      10
    );

    assert.strictEqual(result.status, "SUCCESS");
    assert.strictEqual(result.ledger, 5035999);
    assert.strictEqual(result.hash, "real_tx_hash_12345");
  });

  test("pollTransactionConfirmation throws on onchain FAILED transaction", async () => {
    const mockServer = {
      getTransaction: async () => ({
        status: "FAILED",
        latestLedger: 5036000,
        resultXdr: {
          toXDR: () => "tx_failed_result_xdr",
        },
      }),
    } as unknown as rpc.Server;

    await assert.rejects(
      () => pollTransactionConfirmation(mockServer, "failed_hash", 2, 10),
      /Transaction failed onchain in ledger 5036000/
    );
  });
});
