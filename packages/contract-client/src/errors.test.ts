import assert from "node:assert";
import { describe, test } from "node:test";
import {
  CONTRACT_ERROR_CATALOG,
  CONTRACT_ERROR_DEFINITIONS,
  ContractError,
  ContractErrorCode,
  UnknownContractError,
  AdminNotFoundError,
  EscrowNotFoundError,
  InvalidDisputeSplitError,
  UnauthorizedError,
  UnlockTimeNotReachedError,
  ZeroAmountError,
  contractErrorFromCode,
  describeContractError,
  extractContractErrorCode,
  isContractError,
  parseContractError,
} from "./errors";

const CODES = Object.values(ContractErrorCode).filter(
  (value): value is ContractErrorCode => typeof value === "number"
);

describe("contract error catalogue", () => {
  test("documents every declared code exactly once", () => {
    assert.equal(CONTRACT_ERROR_DEFINITIONS.length, CODES.length);
    assert.deepEqual(
      CONTRACT_ERROR_DEFINITIONS.map((definition) => definition.code).sort(
        (a, b) => a - b
      ),
      CODES.slice().sort((a, b) => a - b)
    );
    for (const code of CODES) {
      assert.ok(CONTRACT_ERROR_CATALOG[code], `missing catalogue entry for ${code}`);
    }
  });

  test("every code produces a typed, user-facing error", () => {
    for (const definition of CONTRACT_ERROR_DEFINITIONS) {
      const error = contractErrorFromCode(definition.code);
      assert.ok(error instanceof ContractError);
      assert.ok(error instanceof Error);
      assert.equal(error.code, definition.code);
      assert.equal(error.errorName, definition.name);
      assert.match(error.message, new RegExp(`#${definition.code}`));
      assert.ok(error.message.includes(definition.description));
      assert.ok(error.remediation.length > 20);
      assert.equal(isContractError(error), true);
    }
  });

  test("exposes distinct subclasses for security-critical codes", () => {
    assert.ok(contractErrorFromCode(3) instanceof UnauthorizedError);
    assert.ok(contractErrorFromCode(4) instanceof EscrowNotFoundError);
    assert.ok(contractErrorFromCode(6) instanceof UnlockTimeNotReachedError);
    assert.ok(contractErrorFromCode(8) instanceof ZeroAmountError);
    assert.ok(contractErrorFromCode(12) instanceof InvalidDisputeSplitError);
    assert.ok(contractErrorFromCode(23) instanceof AdminNotFoundError);
    assert.notEqual(
      contractErrorFromCode(5).constructor,
      contractErrorFromCode(6).constructor
    );
  });

  test("escrow lock errors carry actionable remediation", () => {
    const error = contractErrorFromCode(6);
    assert.match(error.message, /lock period/i);
    assert.match(error.remediation, /unlock_timestamp/);
  });

  test("unknown codes stay typed and preserve the numeric value", () => {
    const error = contractErrorFromCode(9_999);
    assert.ok(error instanceof UnknownContractError);
    assert.equal(error.code, 9_999);
    assert.match(error.message, /9999/);
    assert.equal(error.errorName, "UnknownContractError");
  });

  test("attaches contract context and preserves the underlying cause", () => {
    const cause = new Error("rpc exploded");
    const error = contractErrorFromCode(5, {
      contractId: "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT",
      rpcMessage: "HostError: Error(Contract, #5)",
      cause,
    });
    assert.equal(
      error.contractId,
      "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT"
    );
    assert.equal(error.rpcMessage, "HostError: Error(Contract, #5)");
    assert.equal(error.cause, cause);
  });

  test("describeContractError combines message and remediation", () => {
    const description = describeContractError(4);
    assert.match(description, /does not exist/i);
    assert.match(description, /escrow ID/i);
  });
});

describe("extractContractErrorCode", () => {
  test("reads the canonical Soroban diagnostic", () => {
    assert.equal(
      extractContractErrorCode("HostError: Error(Contract, #6)"),
      6
    );
    assert.equal(extractContractErrorCode("Error(Contract,#12)"), 12);
    assert.equal(extractContractErrorCode("error(contract, #3)"), 3);
  });

  test("reads descriptive diagnostics", () => {
    assert.equal(
      extractContractErrorCode("simulation failed: contract error #25"),
      25
    );
  });

  test("ignores text without a contract code", () => {
    assert.equal(extractContractErrorCode("connection refused"), undefined);
    assert.equal(extractContractErrorCode("Error(Contract)"), undefined);
    assert.equal(extractContractErrorCode(""), undefined);
  });
});

describe("parseContractError", () => {
  test("parses a raw diagnostic string", () => {
    const error = parseContractError("HostError: Error(Contract, #6)");
    assert.ok(error instanceof UnlockTimeNotReachedError);
    assert.equal(error.rpcMessage, "HostError: Error(Contract, #6)");
  });

  test("parses simulation failure responses", () => {
    const response = {
      error: "HostError: Error(Contract, #5)",
      events: [{ event: { contractId: "C..." } }],
      latestLedger: 1_000,
    };
    const error = parseContractError(response, { contractId: "CTEST" });
    assert.ok(error);
    assert.equal(error.code, ContractErrorCode.InvalidStatus);
    assert.equal(error.contractId, "CTEST");
  });

  test("parses nested error objects", () => {
    const error = parseContractError({
      error: { message: "transaction failed: Error(Contract, #8)" },
    });
    assert.ok(error instanceof ZeroAmountError);
  });

  test("parses Error instances and keeps them as the cause", () => {
    const cause = new Error("Error(Contract, #3)");
    const error = parseContractError(cause);
    assert.ok(error instanceof UnauthorizedError);
    assert.equal(error.cause, cause);
  });

  test("parses numeric codes from structured fields", () => {
    assert.equal(parseContractError({ contractErrorCode: 4 })?.code, 4);
    assert.equal(parseContractError({ contractErrorCode: "12" })?.code, 12);
    assert.equal(parseContractError({ code: 23 })?.code, 23);
    assert.equal(parseContractError(10)?.code, 10);
    assert.equal(parseContractError({ message: "Error(Contract, #26)" })?.code, 26);
  });

  test("returns typed errors unchanged", () => {
    const original = contractErrorFromCode(9);
    assert.equal(parseContractError(original), original);
  });

  test("returns undefined when no contract code is present", () => {
    assert.equal(parseContractError(undefined), undefined);
    assert.equal(parseContractError(null), undefined);
    assert.equal(parseContractError("timeout after 60s"), undefined);
    assert.equal(parseContractError(new TypeError("bad input")), undefined);
    assert.equal(parseContractError({}), undefined);
    assert.equal(parseContractError({ code: "ECONNREFUSED" }), undefined);
    assert.equal(parseContractError(-1), undefined);
  });

  test("does not recurse without bound on cyclic objects", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.error = cyclic;
    assert.equal(parseContractError(cyclic), undefined);
  });
});
