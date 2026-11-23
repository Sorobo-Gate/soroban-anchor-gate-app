import { describe, it } from "node:test";
import assert from "node:assert";
import {
  EscrowErrorCode,
  ERROR_DEFINITIONS,
  ContractError,
  NotInitializedError,
  AlreadyInitializedError,
  UnauthorizedError,
  EscrowNotFoundError,
  InvalidStatusError,
  UnlockTimeNotReachedError,
  UnlockTimePassedError,
  ZeroAmountError,
  InvalidBpsError,
  ArithmeticOverflowError,
  TokenNotWhitelistedError,
  InvalidDisputeSplitError,
  EmptyDisbursementError,
  TooManyDisbursementsError,
  InvalidDisbursementAmountError,
  DisbursementMismatchError,
  ClawbackNotAllowedError,
  ProposalNotFoundError,
  ProposalAlreadyExecutedError,
  CannotConfirmOwnProposalError,
  AdminAlreadyExistsError,
  CannotRemoveLastAdminError,
  AdminNotFoundError,
  MigrationFailedError,
  UnknownContractError,
  createContractError,
  extractErrorCode,
  parseContractError,
} from "./errors.js";

describe("Typed Contract Error Parser & Hierarchy", () => {
  it("defines all contract error codes from 1 to 24 with metadata", () => {
    for (let code = 1; code <= 24; code++) {
      const def = ERROR_DEFINITIONS[code as EscrowErrorCode];
      assert.ok(def, `Missing error definition for code ${code}`);
      assert.strictEqual(def.code, code);
      assert.ok(def.name.length > 0);
      assert.ok(def.message.length > 0);
      assert.ok(def.remediation.length > 0);
    }
  });

  it("instantiates concrete typed error classes with proper prototype chain", () => {
    const err = new NotInitializedError();
    assert.ok(err instanceof ContractError);
    assert.ok(err instanceof Error);
    assert.ok(err instanceof NotInitializedError);
    assert.strictEqual(err.code, EscrowErrorCode.NotInitialized);
    assert.strictEqual(err.errorName, "NotInitialized");
    assert.ok(err.message.includes("not been initialized yet"));
    assert.ok(err.remediation.includes("init"));
  });

  it("instantiates all 24 error subclasses through createContractError", () => {
    const classes = [
      NotInitializedError,
      AlreadyInitializedError,
      UnauthorizedError,
      EscrowNotFoundError,
      InvalidStatusError,
      UnlockTimeNotReachedError,
      UnlockTimePassedError,
      ZeroAmountError,
      InvalidBpsError,
      ArithmeticOverflowError,
      TokenNotWhitelistedError,
      InvalidDisputeSplitError,
      EmptyDisbursementError,
      TooManyDisbursementsError,
      InvalidDisbursementAmountError,
      DisbursementMismatchError,
      ClawbackNotAllowedError,
      ProposalNotFoundError,
      ProposalAlreadyExecutedError,
      CannotConfirmOwnProposalError,
      AdminAlreadyExistsError,
      CannotRemoveLastAdminError,
      AdminNotFoundError,
      MigrationFailedError,
    ];

    for (let code = 1; code <= 24; code++) {
      const err = createContractError(code);
      const ExpectedClass = classes[code - 1];
      assert.ok(err instanceof ExpectedClass);
      assert.strictEqual(err.code, code);
    }
  });

  it("creates UnknownContractError for uncataloged error codes", () => {
    const err = createContractError(999);
    assert.ok(err instanceof UnknownContractError);
    assert.ok(err instanceof ContractError);
    assert.strictEqual(err.code, 999);
    assert.strictEqual(err.errorName, "UnknownContractError");
  });

  it("extracts error codes from various raw string patterns", () => {
    assert.strictEqual(extractErrorCode("HostError: Error(Contract, #6)"), 6);
    assert.strictEqual(extractErrorCode("Transaction failed with Error(Contract, 11)"), 11);
    assert.strictEqual(extractErrorCode("ContractError(4)"), 4);
    assert.strictEqual(extractErrorCode("error code: #12"), 12);
    assert.strictEqual(extractErrorCode('{"code": 3}'), 3);
    assert.strictEqual(extractErrorCode(5), 5);
    assert.strictEqual(extractErrorCode("Unknown error with no code"), undefined);
    assert.strictEqual(extractErrorCode(null), undefined);
  });

  it("extracts error codes from Soroban simulation failure response objects", () => {
    const simResult = {
      error: "HostError: Error(Contract, #5)",
    };
    assert.strictEqual(extractErrorCode(simResult), 5);

    const nestedResult = {
      results: [
        {
          error: "Transaction simulation failed with Error(Contract, #10)",
        },
      ],
    };
    assert.strictEqual(extractErrorCode(nestedResult), 10);

    const directCodeObj = {
      code: 1,
      message: "Contract error",
    };
    assert.strictEqual(extractErrorCode(directCodeObj), 1);
  });

  it("parses simulation error into specific typed error subclass", () => {
    const rawError = {
      error: "HostError: Error(Contract, #6)",
    };
    const parsed = parseContractError(rawError);
    assert.ok(parsed instanceof UnlockTimeNotReachedError);
    assert.strictEqual(parsed.code, 6);
    assert.ok(parsed.remediation.includes("unlock_timestamp"));
    assert.strictEqual(parsed.rawError, rawError);
  });

  it("idempotently returns existing ContractError instances", () => {
    const original = new UnauthorizedError();
    const parsed = parseContractError(original);
    assert.strictEqual(parsed, original);
  });

  it("returns undefined when no contract error can be determined", () => {
    assert.strictEqual(parseContractError("Network timeout connecting to RPC"), undefined);
    assert.strictEqual(parseContractError(new Error("Generic exception")), undefined);
  });
});
