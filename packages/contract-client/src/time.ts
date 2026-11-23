/**
 * Time-lock deadline calculation with clock-drift mitigation.
 *
 * A contract compares `unlock_time` against the ledger consensus clock, not a
 * client's wall clock. Client machines can be minutes ahead or behind, so
 * computing a deadline from `Date.now()` can make an escrow unlock early or
 * lock longer than intended. This module anchors the deadline to the latest
 * ledger close time reported by Soroban RPC and adds a safety margin.
 *
 * @packageDocumentation
 */

import { rpc } from "@stellar/stellar-sdk";
import { ClientConfig, validateClientConfig } from "./index";

/** Default safety margin, in seconds, added to every calculated deadline. */
export const DEFAULT_CLOCK_DRIFT_MARGIN_SECONDS = 300;

/**
 * Minimal RPC surface needed to read the ledger consensus clock.
 */
export interface LedgerClockServer {
  /** Returns the latest ledger, including its close time when supported. */
  getLatestLedger(): Promise<{ sequence: number; closeTime?: number }>;
  /** Optional ledger-range query used when `closeTime` is not reported. */
  getLedgers?(params: {
    startLedger: number;
    limit?: number;
  }): Promise<{ ledgers: Array<{ ledgerCloseTime?: number }> }>;
}

/**
 * Options for {@link calculateSafeUnlockTime}.
 */
export interface CalculateSafeUnlockTimeOptions {
  /** Contract and RPC settings used to create the default RPC server. */
  config?: ClientConfig;
  /** Injectable RPC server, primarily for tests or custom transports. */
  server?: LedgerClockServer;
  /** Safety margin in seconds. Defaults to {@link DEFAULT_CLOCK_DRIFT_MARGIN_SECONDS}. */
  safetyMarginSeconds?: number;
}

/**
 * Calculates a safe `unlock_time` relative to the ledger consensus clock.
 *
 * The deadline is `latest ledger close time + durationSeconds + safety
 * margin`, so drift in the calling machine's clock has no effect. The result
 * is returned as a `bigint` suitable for a Soroban `u64` argument.
 *
 * @param durationSeconds - Lock duration in seconds, relative to now.
 * @param options - Contract configuration, server override, and margin.
 * @returns The absolute unlock timestamp in Unix seconds.
 * @throws {Error} If the duration is negative or not an integer, the
 *   configuration is invalid, or the RPC server does not report a ledger
 *   close time.
 *
 * @example
 * ```ts
 * const unlockTime = await calculateSafeUnlockTime(3_600, { config });
 * // ledgerCloseTime + 3600 + 300
 * ```
 */
export async function calculateSafeUnlockTime(
  durationSeconds: number,
  options: CalculateSafeUnlockTimeOptions = {}
): Promise<bigint> {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 0) {
    throw new Error("durationSeconds must be a non-negative integer");
  }

  const margin =
    options.safetyMarginSeconds ?? DEFAULT_CLOCK_DRIFT_MARGIN_SECONDS;
  if (!Number.isInteger(margin) || margin < 0) {
    throw new Error("safetyMarginSeconds must be a non-negative integer");
  }

  let server: LedgerClockServer;
  if (options.server) {
    server = options.server;
  } else {
    if (!options.config) {
      throw new Error("Either config or server must be provided");
    }
    validateClientConfig(options.config);
    server = new rpc.Server(options.config.rpcUrl, {
      allowHttp: options.config.rpcUrl.startsWith("http://"),
    }) as unknown as LedgerClockServer;
  }

  const latest = await server.getLatestLedger();
  let closeTime = latest.closeTime;

  if (closeTime === undefined && typeof server.getLedgers === "function") {
    const res = await server.getLedgers({
      startLedger: latest.sequence,
      limit: 1,
    });
    closeTime = res.ledgers?.[0]?.ledgerCloseTime;
  }

  if (closeTime === undefined || !Number.isFinite(closeTime)) {
    throw new Error("Soroban RPC did not report a ledger close time");
  }

  return BigInt(Math.floor(closeTime + durationSeconds + margin));
}
