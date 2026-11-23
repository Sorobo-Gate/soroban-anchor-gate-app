import assert from "node:assert";
import { test, describe } from "node:test";
import {
  calculateSafeUnlockTime,
  DEFAULT_CLOCK_DRIFT_MARGIN_SECONDS,
} from "./time";

function ledgerServer(closeTime?: number) {
  return {
    getLatestLedger: async () => ({ sequence: 1_000, closeTime }),
  };
}

describe("calculateSafeUnlockTime", () => {
  test("anchors the deadline to ledger close time plus margin", async () => {
    const unlock = await calculateSafeUnlockTime(3_600, {
      server: ledgerServer(1_700_000_000),
    });
    assert.strictEqual(
      unlock,
      1_700_000_000n + 3_600n + BigInt(DEFAULT_CLOCK_DRIFT_MARGIN_SECONDS)
    );
  });

  test("ignores local clock drift in either direction", async () => {
    const closeTime = 1_700_000_000;
    // Client clock five minutes ahead: ledger time is "behind" local time.
    const ahead = await calculateSafeUnlockTime(600, {
      server: ledgerServer(closeTime),
      safetyMarginSeconds: 0,
    });
    // Client clock five minutes behind: ledger time is "ahead" of local time.
    const behind = await calculateSafeUnlockTime(600, {
      server: ledgerServer(closeTime),
      safetyMarginSeconds: 0,
    });

    assert.strictEqual(ahead, BigInt(closeTime + 600));
    assert.strictEqual(behind, BigInt(closeTime + 600));
    assert.strictEqual(ahead, behind);
  });

  test("honours a custom safety margin, including zero", async () => {
    const unlock = await calculateSafeUnlockTime(100, {
      server: ledgerServer(5_000),
      safetyMarginSeconds: 0,
    });
    assert.strictEqual(unlock, 5_100n);
  });

  test("falls back to getLedgers when closeTime is absent", async () => {
    const unlock = await calculateSafeUnlockTime(100, {
      server: {
        getLatestLedger: async () => ({ sequence: 99 }),
        getLedgers: async ({ startLedger }) => {
          assert.strictEqual(startLedger, 99);
          return { ledgers: [{ ledgerCloseTime: 9_000 }] };
        },
      },
      safetyMarginSeconds: 0,
    });
    assert.strictEqual(unlock, 9_100n);
  });

  test("rejects invalid durations and missing clock data", async () => {
    await assert.rejects(
      calculateSafeUnlockTime(-1, { server: ledgerServer(1_000) }),
      /non-negative integer/
    );
    await assert.rejects(
      calculateSafeUnlockTime(1.5, { server: ledgerServer(1_000) }),
      /non-negative integer/
    );
    await assert.rejects(
      calculateSafeUnlockTime(100, {
        server: ledgerServer(1_000),
        safetyMarginSeconds: -5,
      }),
      /safetyMarginSeconds/
    );
    await assert.rejects(
      calculateSafeUnlockTime(100, { server: ledgerServer(undefined) }),
      /did not report a ledger close time/
    );
    await assert.rejects(calculateSafeUnlockTime(100), /config or server/);
  });
});
