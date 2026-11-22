import assert from "node:assert";
import { describe, test } from "node:test";
import {
  BudgetProfileError,
  DEFAULT_CPU_INSN_LIMIT,
  DEFAULT_MEM_BYTES_LIMIT,
  DEFAULT_WARNING_THRESHOLD,
  profileGasBudget,
} from "./index";
import type { BudgetWarning } from "./index";

interface LoggedWarning {
  message: string;
  warning: BudgetWarning;
}

function captureWarnings(): {
  logger: (message: string, warning: BudgetWarning) => void;
  calls: LoggedWarning[];
} {
  const calls: LoggedWarning[] = [];
  return {
    calls,
    logger: (message, warning) => {
      calls.push({ message, warning });
    },
  };
}

function assertBudgetError(
  action: () => unknown,
  kind: "invalid_cost" | "invalid_options"
): void {
  assert.throws(action, (caught: unknown) => {
    assert.ok(caught instanceof BudgetProfileError);
    assert.strictEqual(caught.kind, kind);
    return true;
  });
}

describe("profileGasBudget", () => {
  test("warns when CPU usage exceeds 80% of the default limit", () => {
    const { logger, calls } = captureWarnings();

    const profile = profileGasBudget(
      { cpuInsns: "85000000", memBytes: 1_000_000 },
      { logger }
    );

    assert.strictEqual(profile.exceedsWarningThreshold, true);
    assert.strictEqual(profile.warnings.length, 1);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(profile.cpu.used, 85_000_000);
    assert.strictEqual(profile.cpu.limit, DEFAULT_CPU_INSN_LIMIT);
    assert.strictEqual(profile.cpu.utilization, 0.85);
    assert.strictEqual(profile.cpu.percentage, 85);
    assert.strictEqual(profile.cpu.exceedsWarningThreshold, true);
    assert.strictEqual(profile.memory.exceedsWarningThreshold, false);

    const warning = profile.warnings[0];
    assert.strictEqual(warning.resource, "cpuInsns");
    assert.strictEqual(warning.used, 85_000_000);
    assert.strictEqual(warning.limit, DEFAULT_CPU_INSN_LIMIT);
    assert.strictEqual(warning.utilization, 0.85);
    assert.strictEqual(warning.percentage, 85);
    assert.strictEqual(warning.threshold, DEFAULT_WARNING_THRESHOLD);
    assert.match(warning.message, /CPU instructions/);
    assert.match(warning.message, /85\.00%/);
    assert.strictEqual(calls[0].message, warning.message);
    assert.strictEqual(calls[0].warning, warning);
  });

  test("warns when memory usage exceeds 80% of the default limit", () => {
    const { logger, calls } = captureWarnings();

    const profile = profileGasBudget(
      { cpuInsns: 1_000_000, memBytes: "37748736" },
      { logger }
    );

    assert.strictEqual(profile.warnings.length, 1);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(profile.memory.used, 37_748_736);
    assert.strictEqual(profile.memory.limit, DEFAULT_MEM_BYTES_LIMIT);
    assert.strictEqual(profile.memory.utilization, 0.9);
    assert.strictEqual(profile.memory.percentage, 90);
    assert.strictEqual(profile.memory.exceedsWarningThreshold, true);
    assert.strictEqual(profile.cpu.exceedsWarningThreshold, false);

    const warning = profile.warnings[0];
    assert.strictEqual(warning.resource, "memBytes");
    assert.match(warning.message, /memory bytes/);
    assert.match(warning.message, /90\.00%/);
  });

  test("warns for combined high CPU and high memory with accurate diagnostics", () => {
    const { logger, calls } = captureWarnings();

    const profile = profileGasBudget(
      { cpuInsns: 90_000_000, memBytes: 37_748_736 },
      { logger }
    );

    assert.strictEqual(profile.exceedsWarningThreshold, true);
    assert.strictEqual(profile.warnings.length, 2);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(profile.cpu.percentage, 90);
    assert.strictEqual(profile.memory.percentage, 90);
    assert.strictEqual(profile.warnings[0].resource, "cpuInsns");
    assert.strictEqual(profile.warnings[0].percentage, 90);
    assert.strictEqual(profile.warnings[1].resource, "memBytes");
    assert.strictEqual(profile.warnings[1].percentage, 90);
    assert.match(profile.warnings[0].message, /90\.00%/);
    assert.match(profile.warnings[1].message, /90\.00%/);
    assert.strictEqual(calls[0].warning, profile.warnings[0]);
    assert.strictEqual(calls[1].warning, profile.warnings[1]);
  });

  test("does not warn at exactly 80% but warns just above it", () => {
    const atBoundary = captureWarnings();
    const safe = profileGasBudget(
      { cpuInsns: 80_000_000, memBytes: 33_554_432 },
      { logger: atBoundary.logger }
    );

    assert.strictEqual(safe.exceedsWarningThreshold, false);
    assert.strictEqual(safe.warnings.length, 0);
    assert.strictEqual(atBoundary.calls.length, 0);
    assert.strictEqual(safe.cpu.utilization, 0.8);
    assert.strictEqual(safe.memory.utilization, 0.8);
    assert.strictEqual(safe.cpu.percentage, 80);
    assert.strictEqual(safe.memory.percentage, 80);
    assert.strictEqual(safe.cpu.exceedsWarningThreshold, false);
    assert.strictEqual(safe.memory.exceedsWarningThreshold, false);

    const overBoundary = captureWarnings();
    const unsafe = profileGasBudget(
      { cpuInsns: 80_000_001, memBytes: 33_554_433 },
      { logger: overBoundary.logger }
    );

    assert.strictEqual(unsafe.exceedsWarningThreshold, true);
    assert.strictEqual(unsafe.warnings.length, 2);
    assert.strictEqual(overBoundary.calls.length, 2);
    assert.strictEqual(unsafe.cpu.exceedsWarningThreshold, true);
    assert.strictEqual(unsafe.memory.exceedsWarningThreshold, true);
    assert.ok(unsafe.cpu.percentage > 80);
    assert.ok(unsafe.memory.percentage > 80);
  });

  test("reports zero usage without warnings", () => {
    const { logger, calls } = captureWarnings();

    const profile = profileGasBudget(
      { cpuInsns: "0", memBytes: 0 },
      { logger }
    );

    assert.strictEqual(profile.exceedsWarningThreshold, false);
    assert.strictEqual(profile.warnings.length, 0);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(profile.cpu.used, 0);
    assert.strictEqual(profile.cpu.utilization, 0);
    assert.strictEqual(profile.cpu.percentage, 0);
    assert.strictEqual(profile.memory.used, 0);
    assert.strictEqual(profile.memory.utilization, 0);
    assert.strictEqual(profile.memory.percentage, 0);
  });

  test("accepts a complete simulation response and parses string cost values", () => {
    const { logger, calls } = captureWarnings();

    const profile = profileGasBudget(
      {
        latestLedger: 500,
        cost: { cpuInsns: "90000000", memBytes: "37748736" },
      },
      { logger }
    );

    assert.strictEqual(profile.cpu.used, 90_000_000);
    assert.strictEqual(profile.memory.used, 37_748_736);
    assert.strictEqual(profile.warnings.length, 2);
    assert.strictEqual(calls.length, 2);
  });

  test("supports custom limits and warning thresholds", () => {
    const atCustomThreshold = captureWarnings();
    const safe = profileGasBudget(
      { cpuInsns: 500, memBytes: 1_000 },
      {
        limits: { cpuInsns: 1_000, memBytes: 2_000 },
        warningThreshold: 0.5,
        logger: atCustomThreshold.logger,
      }
    );

    assert.strictEqual(safe.warningThreshold, 0.5);
    assert.strictEqual(safe.cpu.limit, 1_000);
    assert.strictEqual(safe.memory.limit, 2_000);
    assert.strictEqual(safe.cpu.utilization, 0.5);
    assert.strictEqual(safe.memory.utilization, 0.5);
    assert.strictEqual(safe.warnings.length, 0);
    assert.strictEqual(atCustomThreshold.calls.length, 0);

    const overCustomThreshold = captureWarnings();
    const unsafe = profileGasBudget(
      { cpuInsns: 501, memBytes: 1_001 },
      {
        limits: { cpuInsns: "1000", memBytes: "2000" },
        warningThreshold: 0.5,
        logger: overCustomThreshold.logger,
      }
    );

    assert.strictEqual(unsafe.warnings.length, 2);
    assert.strictEqual(overCustomThreshold.calls.length, 2);
    assert.match(unsafe.warnings[0].message, /50% warning threshold/);
  });

  test("rejects missing, malformed, negative, and non-finite costs", () => {
    const invalidCosts: unknown[] = [
      undefined,
      null,
      "not-an-object",
      [],
      {},
      { cpuInsns: 1 },
      { memBytes: 1 },
      { cpuInsns: -1, memBytes: 0 },
      { cpuInsns: 0, memBytes: -1 },
      { cpuInsns: Number.NaN, memBytes: 0 },
      { cpuInsns: Number.POSITIVE_INFINITY, memBytes: 0 },
      { cpuInsns: Number.MAX_SAFE_INTEGER + 1, memBytes: 0 },
      { cpuInsns: "abc", memBytes: 0 },
      { cpuInsns: "1.5", memBytes: 0 },
      { cpuInsns: "", memBytes: 0 },
      { cpuInsns: 0, memBytes: "0x10" },
      { cost: "not-an-object" },
    ];

    for (const cost of invalidCosts) {
      assertBudgetError(() => profileGasBudget(cost), "invalid_cost");
    }
  });

  test("rejects malformed profiler options", () => {
    const cost = { cpuInsns: 1, memBytes: 1 };

    assertBudgetError(
      () => profileGasBudget(cost, null as unknown as object),
      "invalid_options"
    );
    assertBudgetError(
      () => profileGasBudget(cost, { warningThreshold: -0.1 }),
      "invalid_options"
    );
    assertBudgetError(
      () => profileGasBudget(cost, { warningThreshold: 1.1 }),
      "invalid_options"
    );
    assertBudgetError(
      () => profileGasBudget(cost, { warningThreshold: Number.NaN }),
      "invalid_options"
    );
    assertBudgetError(
      () =>
        profileGasBudget(cost, {
          warningThreshold: "0.8" as unknown as number,
        }),
      "invalid_options"
    );
    assertBudgetError(
      () => profileGasBudget(cost, { limits: null as unknown as object }),
      "invalid_options"
    );
    assertBudgetError(
      () => profileGasBudget(cost, { limits: { cpuInsns: 0 } }),
      "invalid_options"
    );
    assertBudgetError(
      () => profileGasBudget(cost, { limits: { memBytes: -1 } }),
      "invalid_options"
    );
    assertBudgetError(
      () =>
        profileGasBudget(cost, {
          logger: null as unknown as () => void,
        }),
      "invalid_options"
    );
  });
});
