/**
 * Deterministic dispute split calculation for arbiter resolutions.
 *
 * When a dispute is resolved, the escrow amount is divided between the
 * payer and the beneficiary according to a basis-point split that always
 * sums to 10,000. The payer receives the exact share
 * `floor(amount * payerBps / 10_000)` and the beneficiary receives the
 * remainder, mirroring the on-chain `resolve_dispute` behavior in
 * `contracts/src/lib.rs`, so indivisible stroops always land in the
 * beneficiary's pocket with no rounding leakage:
 * `payerAmount + beneficiaryAmount === totalAmount`.
 *
 * @packageDocumentation
 */

/**
 * Number of basis points that make up a full split.
 *
 * A valid dispute split must award every basis point, so
 * `payerBps + beneficiaryBps` always equals this divisor.
 */
export const BPS_DIVISOR = 10_000n;

/**
 * Maximum share in basis points, out of {@link BPS_DIVISOR}.
 */
export const MAX_BPS = 10_000;

/**
 * Result of {@link calculateDisputeSplit}: the stroop amounts each party
 * receives when a disputed escrow is resolved.
 */
export interface DisputeSplit {
  /** Stroops awarded to the payer: `floor(totalAmount * payerBps / 10_000)`. */
  payerAmount: bigint;
  /** Stroops awarded to the beneficiary: `totalAmount - payerAmount`. */
  beneficiaryAmount: bigint;
}

function assertValidBps(bps: number, name: string): void {
  if (
    !Number.isFinite(bps) ||
    !Number.isInteger(bps) ||
    bps < 0 ||
    bps > MAX_BPS
  ) {
    throw new Error(
      `${name} must be an integer between 0 and ${MAX_BPS} (inclusive)`
    );
  }
}

/**
 * Splits a disputed escrow amount between the payer and the beneficiary.
 *
 * The split is computed with exact `BigInt` arithmetic. The payer receives
 * the truncated share `floor(totalAmount * payerBps / 10_000)`; the
 * beneficiary receives the remainder, so
 * `payerAmount + beneficiaryAmount === totalAmount` always holds and no
 * stroop is lost to rounding.
 *
 * @param totalAmount - Non-negative escrow amount in stroops.
 * @param payerBps - Payer share in basis points, between `0` and `10_000`
 *   inclusive.
 * @param beneficiaryBps - Beneficiary share in basis points, between `0`
 *   and `10_000` inclusive.
 * @returns The deterministic payer and beneficiary stroop allocations.
 * @throws {Error} If `totalAmount` is not a non-negative `bigint`, if either
 *   bps value is not a finite integer between `0` and `10_000`, or if
 *   `payerBps + beneficiaryBps !== 10_000`.
 *
 * @example
 * ```ts
 * calculateDisputeSplit(10_000n, 6_000, 4_000);
 * // { payerAmount: 6_000n, beneficiaryAmount: 4_000n }
 *
 * calculateDisputeSplit(1n, 5_000, 5_000);
 * // { payerAmount: 0n, beneficiaryAmount: 1n } — remainder goes to beneficiary
 * ```
 */
export function calculateDisputeSplit(
  totalAmount: bigint,
  payerBps: number,
  beneficiaryBps: number
): DisputeSplit {
  if (typeof totalAmount !== "bigint" || totalAmount < 0n) {
    throw new Error("totalAmount must be a non-negative bigint");
  }
  assertValidBps(payerBps, "payerBps");
  assertValidBps(beneficiaryBps, "beneficiaryBps");
  if (payerBps + beneficiaryBps !== MAX_BPS) {
    throw new Error(
      "Dispute split basis points must sum to exactly 10,000 (100%)"
    );
  }

  const payerAmount = (totalAmount * BigInt(payerBps)) / BPS_DIVISOR;
  const beneficiaryAmount = totalAmount - payerAmount;
  return { payerAmount, beneficiaryAmount };
}
