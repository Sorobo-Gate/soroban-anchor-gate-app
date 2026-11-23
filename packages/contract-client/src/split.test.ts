import assert from "node:assert";
import { test, describe } from "node:test";
import { BPS_DIVISOR, MAX_BPS, calculateDisputeSplit } from "./split";

const I128_MAX = (1n << 127n) - 1n;

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBigInt(max: bigint, next: () => number): bigint {
  if (max <= 0n) {
    return 0n;
  }
  const width = max.toString(16).length;
  let value = 0n;
  for (let i = 0; i < width; i++) {
    value = value * 16n + BigInt(Math.floor(next() * 16));
  }
  return value % (max + 1n);
}

function randomAmount(next: () => number): bigint {
  const kind = Math.floor(next() * 4);
  if (kind === 0) {
    return randomBigInt(1_000_000n, next);
  }
  if (kind === 1) {
    return randomBigInt(BigInt(Number.MAX_SAFE_INTEGER), next);
  }
  if (kind === 2) {
    return randomBigInt(I128_MAX, next);
  }
  return randomBigInt(10n ** 40n, next);
}

describe("calculateDisputeSplit", () => {
  test("enforces the zero-leakage invariant over 1,000 seeded random amounts", () => {
    const next = mulberry32(0x5eed);
    for (let i = 0; i < 1_000; i++) {
      const totalAmount = randomAmount(next);
      const payerBps = Math.floor(next() * (MAX_BPS + 1));
      const beneficiaryBps = MAX_BPS - payerBps;

      const split = calculateDisputeSplit(
        totalAmount,
        payerBps,
        beneficiaryBps
      );

      assert.ok(
        split.payerAmount + split.beneficiaryAmount === totalAmount,
        `sum mismatch: ${split.payerAmount} + ${split.beneficiaryAmount} !== ${totalAmount} (i=${i})`
      );
      assert.ok(split.payerAmount >= 0n, `negative payerAmount (i=${i})`);
      assert.ok(
        split.beneficiaryAmount >= 0n,
        `negative beneficiaryAmount (i=${i})`
      );
      assert.ok(
        split.payerAmount <= totalAmount,
        `payerAmount exceeds totalAmount (i=${i})`
      );
      assert.ok(
        split.beneficiaryAmount <= totalAmount,
        `beneficiaryAmount exceeds totalAmount (i=${i})`
      );
      assert.strictEqual(
        split.payerAmount,
        (totalAmount * BigInt(payerBps)) / BPS_DIVISOR,
        `payer share is not the truncated proportional amount (i=${i})`
      );
      assert.deepStrictEqual(
        calculateDisputeSplit(totalAmount, payerBps, beneficiaryBps),
        split,
        `non-deterministic result (i=${i})`
      );
    }
  });

  test("handles boundary amounts and extreme values", () => {
    const boundaryAmounts = [
      0n,
      1n,
      2n,
      9_999n,
      10_000n,
      10_001n,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      1n << 64n,
      10n ** 40n + 123_456n,
      I128_MAX,
    ];
    for (const totalAmount of boundaryAmounts) {
      for (const payerBps of [0, 1, 5_000, 9_999, 10_000]) {
        const beneficiaryBps = MAX_BPS - payerBps;
        const split = calculateDisputeSplit(
          totalAmount,
          payerBps,
          beneficiaryBps
        );
        assert.ok(
          split.payerAmount + split.beneficiaryAmount === totalAmount,
          `sum mismatch for ${totalAmount} at ${payerBps}/${beneficiaryBps}`
        );
        assert.ok(
          split.payerAmount >= 0n && split.beneficiaryAmount >= 0n,
          `negative amount for ${totalAmount} at ${payerBps}/${beneficiaryBps}`
        );
        assert.strictEqual(
          split.payerAmount,
          (totalAmount * BigInt(payerBps)) / BPS_DIVISOR
        );
      }
    }
  });

  test("allocates odd amounts deterministically, remainder to the beneficiary", () => {
    assert.deepStrictEqual(calculateDisputeSplit(0n, 10_000, 0), {
      payerAmount: 0n,
      beneficiaryAmount: 0n,
    });
    assert.deepStrictEqual(calculateDisputeSplit(0n, 0, 10_000), {
      payerAmount: 0n,
      beneficiaryAmount: 0n,
    });
    assert.deepStrictEqual(calculateDisputeSplit(1n, 10_000, 0), {
      payerAmount: 1n,
      beneficiaryAmount: 0n,
    });
    assert.deepStrictEqual(calculateDisputeSplit(1n, 0, 10_000), {
      payerAmount: 0n,
      beneficiaryAmount: 1n,
    });
    assert.deepStrictEqual(calculateDisputeSplit(1n, 5_000, 5_000), {
      payerAmount: 0n,
      beneficiaryAmount: 1n,
    });
    assert.deepStrictEqual(calculateDisputeSplit(10_000n, 5_000, 5_000), {
      payerAmount: 5_000n,
      beneficiaryAmount: 5_000n,
    });
    assert.deepStrictEqual(calculateDisputeSplit(9_999n, 5_000, 5_000), {
      payerAmount: 4_999n,
      beneficiaryAmount: 5_000n,
    });
    assert.deepStrictEqual(calculateDisputeSplit(10_001n, 5_000, 5_000), {
      payerAmount: 5_000n,
      beneficiaryAmount: 5_001n,
    });
    assert.deepStrictEqual(calculateDisputeSplit(10_001n, 10_000, 0), {
      payerAmount: 10_001n,
      beneficiaryAmount: 0n,
    });
    assert.deepStrictEqual(
      calculateDisputeSplit(10n ** 40n, 5_000, 5_000),
      {
        payerAmount: (10n ** 40n * 5_000n) / BPS_DIVISOR,
        beneficiaryAmount: 10n ** 40n - (10n ** 40n * 5_000n) / BPS_DIVISOR,
      }
    );
    assert.deepStrictEqual(calculateDisputeSplit(I128_MAX, 6_000, 4_000), {
      payerAmount: (I128_MAX * 6_000n) / BPS_DIVISOR,
      beneficiaryAmount: I128_MAX - (I128_MAX * 6_000n) / BPS_DIVISOR,
    });
  });

  test("rejects invalid amounts and bps values", () => {
    assert.throws(
      () => calculateDisputeSplit(-1n, 5_000, 5_000),
      /non-negative bigint/
    );
    assert.throws(
      () => calculateDisputeSplit(1 as never, 5_000, 5_000),
      /non-negative bigint/
    );
    assert.throws(
      () => calculateDisputeSplit("100" as never, 5_000, 5_000),
      /non-negative bigint/
    );
    assert.throws(
      () => calculateDisputeSplit(null as never, 5_000, 5_000),
      /non-negative bigint/
    );
    assert.throws(
      () => calculateDisputeSplit(undefined as never, 5_000, 5_000),
      /non-negative bigint/
    );

    assert.throws(
      () => calculateDisputeSplit(1n, 5_000, 4_000),
      /sum to exactly 10,000/
    );
    assert.throws(
      () => calculateDisputeSplit(1n, 0, 0),
      /sum to exactly 10,000/
    );
    assert.throws(
      () => calculateDisputeSplit(1n, 10_000, 1),
      /sum to exactly 10,000/
    );
    assert.throws(
      () => calculateDisputeSplit(1n, 5_001, 5_001),
      /sum to exactly 10,000/
    );

    assert.throws(
      () => calculateDisputeSplit(1n, -1, 10_001),
      /payerBps/
    );
    assert.throws(
      () => calculateDisputeSplit(1n, 10_001, -1),
      /payerBps/
    );
    assert.throws(
      () => calculateDisputeSplit(1n, 10_001, 0),
      /payerBps/
    );
    assert.throws(
      () => calculateDisputeSplit(1n, 0, 10_001),
      /beneficiaryBps/
    );
    assert.throws(
      () => calculateDisputeSplit(1n, 5_000.5, 4_999.5),
      /payerBps/
    );
    assert.throws(
      () => calculateDisputeSplit(1n, 5_000, 5_000.5),
      /beneficiaryBps/
    );
    assert.throws(
      () => calculateDisputeSplit(1n, Number.NaN, 10_000),
      /payerBps/
    );
    assert.throws(
      () => calculateDisputeSplit(1n, 10_000, Number.NaN),
      /beneficiaryBps/
    );
    assert.throws(
      () =>
        calculateDisputeSplit(
          1n,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY
        ),
      /payerBps/
    );
    assert.throws(
      () => calculateDisputeSplit(1n, "5000" as never, 5_000),
      /payerBps/
    );
  });
});
