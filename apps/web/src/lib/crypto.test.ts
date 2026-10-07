import assert from "node:assert";
import { describe, test } from "node:test";
import { createHash } from "node:crypto";
import { hashRoutingInfo, parseTokenAmount } from "./crypto";

describe("Web Crypto & Amount Arithmetic Helpers", () => {
  test("hashRoutingInfo produces deterministic 64-character SHA-256 hex string", async () => {
    const rawInput = "IBAN: DE89370400440532013000 / BIC: COBADEFFXXX";
    const computedHash = await hashRoutingInfo(rawInput);

    // Cross-verify independently with Node.js crypto
    const expectedHash = createHash("sha256")
      .update(rawInput.trim())
      .digest("hex");

    assert.strictEqual(computedHash, expectedHash);
    assert.strictEqual(computedHash.length, 64);
    assert.match(computedHash, /^[0-9a-f]{64}$/);
  });

  test("hashRoutingInfo rejects empty or whitespace-only inputs", async () => {
    await assert.rejects(
      () => hashRoutingInfo(""),
      /Routing information cannot be empty/
    );
    await assert.rejects(
      () => hashRoutingInfo("   "),
      /Routing information cannot be empty/
    );
  });

  test("parseTokenAmount performs integer-safe conversion without floating-point errors", () => {
    // 100.5 XLM -> 1,005,000,000 stroops (7 decimals)
    assert.strictEqual(parseTokenAmount("100.5", 7), 1005000000n);
    assert.strictEqual(parseTokenAmount("1", 7), 10000000n);
    assert.strictEqual(parseTokenAmount("0.0000001", 7), 1n);

    // Reject excess decimals
    assert.throws(
      () => parseTokenAmount("1.00000001", 7),
      /Amount exceeds maximum supported decimals/
    );

    // Reject negative or invalid numbers
    assert.throws(() => parseTokenAmount("-5", 7), /Invalid token amount string/);
    assert.throws(() => parseTokenAmount("abc", 7), /Invalid token amount string/);
  });
});
