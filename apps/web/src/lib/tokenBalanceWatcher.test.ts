import assert from "node:assert";
import { afterEach, describe, test } from "node:test";
import {
  BASE_RESERVE_STROOPS,
  evaluateBalance,
  fetchAccountBalances,
  formatBaseUnits,
  isAccountFunded,
  minimumXlmReserve,
  parseAmountToBaseUnits,
  parseHorizonAccount,
  type HorizonAccountResponse,
} from "../hooks/useTokenBalance";

const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const ACCOUNT: HorizonAccountResponse = {
  subentry_count: 2,
  num_sponsoring: 0,
  num_sponsored: 0,
  balances: [
    { asset_type: "native", balance: "42.5000000" },
    { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER, balance: "250.0000000" },
  ],
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("balance amount helpers", () => {
  test("parses decimal amounts into 7-decimal base units", () => {
    assert.strictEqual(parseAmountToBaseUnits("1"), 10_000_000n);
    assert.strictEqual(parseAmountToBaseUnits("0.5"), 5_000_000n);
    assert.strictEqual(parseAmountToBaseUnits("250.0000000"), 2_500_000_000n);
    assert.strictEqual(parseAmountToBaseUnits(42.5), 425_000_000n);
  });

  test("truncates excess precision instead of rounding up", () => {
    assert.strictEqual(parseAmountToBaseUnits("0.00000019"), 1n);
  });

  test("returns 0 for empty, malformed, or negative input", () => {
    assert.strictEqual(parseAmountToBaseUnits(""), 0n);
    assert.strictEqual(parseAmountToBaseUnits("   "), 0n);
    assert.strictEqual(parseAmountToBaseUnits("abc"), 0n);
    assert.strictEqual(parseAmountToBaseUnits("-1"), 0n);
    assert.strictEqual(parseAmountToBaseUnits(null), 0n);
    assert.strictEqual(parseAmountToBaseUnits(undefined), 0n);
  });

  test("formats base units back to a trimmed decimal string", () => {
    assert.strictEqual(formatBaseUnits(10_000_000n), "1");
    assert.strictEqual(formatBaseUnits(2_500_000_000n), "250");
    assert.strictEqual(formatBaseUnits(5_000_000n), "0.5");
    assert.strictEqual(formatBaseUnits(1n), "0.0000001");
    assert.strictEqual(formatBaseUnits(0n), "0");
  });
});

describe("minimum XLM reserve", () => {
  test("defaults to 2 base reserves", () => {
    assert.strictEqual(minimumXlmReserve(null), 2n * BASE_RESERVE_STROOPS);
    assert.strictEqual(minimumXlmReserve({}), 10_000_000n);
  });

  test("adds one reserve per subentry", () => {
    assert.strictEqual(
      minimumXlmReserve({ subentry_count: 3 }),
      5n * BASE_RESERVE_STROOPS
    );
  });

  test("accounts for sponsoring and sponsored entries", () => {
    assert.strictEqual(
      minimumXlmReserve({ subentry_count: 4, num_sponsoring: 2, num_sponsored: 1 }),
      7n * BASE_RESERVE_STROOPS
    );
  });

  test("never drops below the 2 reserve baseline", () => {
    assert.strictEqual(
      minimumXlmReserve({ subentry_count: 0, num_sponsored: 9 }),
      2n * BASE_RESERVE_STROOPS
    );
  });
});

describe("parseHorizonAccount", () => {
  test("reads native XLM into stroops with a reserve-adjusted available balance", () => {
    const snapshot = parseHorizonAccount(ACCOUNT);
    assert.strictEqual(snapshot.xlmBalance, 425_000_000n);
    assert.strictEqual(snapshot.minimumXlmReserve, 20_000_000n);
    assert.strictEqual(snapshot.availableXlm, 405_000_000n);
    assert.strictEqual(snapshot.tokenBalance, 425_000_000n);
    assert.strictEqual(snapshot.tokenFound, true);
  });

  test("reads a credit asset balance by code and issuer", () => {
    const snapshot = parseHorizonAccount(ACCOUNT, { code: "USDC", issuer: USDC_ISSUER });
    assert.strictEqual(snapshot.tokenBalance, 2_500_000_000n);
    assert.strictEqual(snapshot.tokenFound, true);
  });

  test("reports zero for a token the account does not hold", () => {
    const snapshot = parseHorizonAccount(ACCOUNT, { code: "EURC", issuer: USDC_ISSUER });
    assert.strictEqual(snapshot.tokenBalance, 0n);
    assert.strictEqual(snapshot.tokenFound, false);
  });

  test("tolerates a malformed or empty payload", () => {
    const snapshot = parseHorizonAccount({});
    assert.strictEqual(snapshot.xlmBalance, 0n);
    assert.strictEqual(snapshot.availableXlm, 0n);
    assert.strictEqual(snapshot.tokenBalance, 0n);
  });

  test("clamps available XLM at zero when the account is below reserve", () => {
    const snapshot = parseHorizonAccount({
      subentry_count: 10,
      balances: [{ asset_type: "native", balance: "2.0000000" }],
    });
    assert.strictEqual(snapshot.availableXlm, 0n);
    assert.strictEqual(isAccountFunded(snapshot), false);
  });
});

describe("evaluateBalance", () => {
  const snapshot = parseHorizonAccount(ACCOUNT, { code: "USDC", issuer: USDC_ISSUER });

  test("allows submission when the token balance covers the amount", () => {
    const check = evaluateBalance(snapshot, 100_0000000n, { tokenSymbol: "USDC" });
    assert.strictEqual(check.sufficient, true);
    assert.strictEqual(check.alert, null);
  });

  test("blocks and explains an insufficient token balance", () => {
    const check = evaluateBalance(snapshot, 300_0000000n, { tokenSymbol: "USDC" });
    assert.strictEqual(check.sufficient, false);
    assert.strictEqual(check.reason, "insufficient-token");
    assert.match(check.alert ?? "", /Insufficient USDC balance/);
    assert.match(check.alert ?? "", /300 required/);
    assert.match(check.alert ?? "", /250 available/);
  });

  test("blocks when the XLM fee would eat into the minimum reserve", () => {
    const check = evaluateBalance(snapshot, 1n, {
      requiredXlmFeeStroops: 500_000_000n,
    });
    assert.strictEqual(check.sufficient, false);
    assert.strictEqual(check.reason, "insufficient-xlm");
    assert.match(check.alert ?? "", /Insufficient XLM/);
  });

  test("allows a fee exactly equal to the available XLM", () => {
    const check = evaluateBalance(snapshot, 1n, {
      requiredXlmFeeStroops: snapshot.availableXlm,
    });
    assert.strictEqual(check.sufficient, true);
  });

  test("blocks with a retry message when balances are unavailable", () => {
    const check = evaluateBalance(null, 1n);
    assert.strictEqual(check.sufficient, false);
    assert.strictEqual(check.reason, "unavailable");
    assert.match(check.alert ?? "", /Unable to verify/);
  });

  test("does not block on an empty amount while the form is still being filled", () => {
    const check = evaluateBalance(snapshot, 0n);
    assert.strictEqual(check.sufficient, true);
  });
});

describe("fetchAccountBalances", () => {
  test("requests the account record from Horizon", async () => {
    let requested = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify(ACCOUNT), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const payload = await fetchAccountBalances("https://horizon-testnet.stellar.org/", "GABCDEF");
    assert.strictEqual(requested, "https://horizon-testnet.stellar.org/accounts/GABCDEF");
    assert.strictEqual(payload.balances?.length, 2);
  });

  test("surfaces Horizon HTTP failures", async () => {
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as typeof fetch;

    await assert.rejects(
      () => fetchAccountBalances("https://horizon-testnet.stellar.org", "GABCDEF"),
      /HTTP 404/
    );
  });

  test("rejects a malformed account payload", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "GABCDEF" }), { status: 200 })) as typeof fetch;

    await assert.rejects(
      () => fetchAccountBalances("https://horizon-testnet.stellar.org", "GABCDEF"),
      /malformed account record/
    );
  });
});
