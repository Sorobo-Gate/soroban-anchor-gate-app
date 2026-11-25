"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Live token / XLM balance watcher used by the escrow forms.
 *
 * Balances are read from Horizon so the payer's spendable token amount and the
 * minimum XLM reserve requirement are known before a transaction is signed.
 */

export const DEFAULT_HORIZON_URL = "https://horizon-testnet.stellar.org";

/** 1 XLM = 10_000_000 stroops. */
export const STROOPS_PER_XLM = 10_000_000n;

/** Base reserve per ledger entry (0.5 XLM). */
export const BASE_RESERVE_STROOPS = 5_000_000n;

/** An account always locks 2 base reserves (account + trustline/signer baseline). */
export const MIN_ACCOUNT_RESERVES = 2n;

export const TOKEN_DECIMALS = 7;

export interface HorizonBalanceEntry {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  balance?: string;
}

export interface HorizonAccountResponse {
  balances?: HorizonBalanceEntry[];
  subentry_count?: number;
  num_sponsoring?: number;
  num_sponsored?: number;
}

export interface AssetRef {
  code?: string;
  issuer?: string;
}

export interface TokenBalanceSnapshot {
  /** Balance of the requested token, in base units. */
  tokenBalance: bigint;
  /** Whether the requested token exists on the account. */
  tokenFound: boolean;
  /** Native XLM balance, in stroops. */
  xlmBalance: bigint;
  /** XLM that must stay locked as reserve, in stroops. */
  minimumXlmReserve: bigint;
  /** XLM spendable on fees/reserve top-ups, in stroops (never negative). */
  availableXlm: bigint;
}

export type BalanceBlockReason =
  | "no-wallet"
  | "unavailable"
  | "insufficient-token"
  | "insufficient-xlm";

export interface BalanceCheck {
  sufficient: boolean;
  reason: BalanceBlockReason | null;
  alert: string | null;
}

/** Parses a Horizon decimal amount string into integer base units. */
export function parseAmountToBaseUnits(
  value: string | number | null | undefined,
  decimals: number = TOKEN_DECIMALS
): bigint {
  if (value === null || value === undefined) return 0n;
  const str = String(value).trim();
  if (str === "" || str === "." || !/^\d*(\.\d*)?$/.test(str)) return 0n;
  const [whole, fraction = ""] = str.split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(`${whole === "" ? "0" : whole}${padded}`);
}

/** Renders integer base units as a decimal string, trimming trailing zeros. */
export function formatBaseUnits(
  value: bigint,
  decimals: number = TOKEN_DECIMALS
): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const raw = abs.toString().padStart(decimals + 1, "0");
  const whole = raw.slice(0, raw.length - decimals);
  const fraction = raw.slice(raw.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Minimum XLM reserve for an account: (2 + subentries + sponsored - sponsoring)
 * base reserves, never below the 2 reserve account baseline.
 */
export function minimumXlmReserve(
  account: Pick<
    HorizonAccountResponse,
    "subentry_count" | "num_sponsoring" | "num_sponsored"
  > | null | undefined
): bigint {
  const subentries = BigInt(Math.max(0, Math.trunc(account?.subentry_count ?? 0)));
  const sponsoring = BigInt(Math.max(0, Math.trunc(account?.num_sponsoring ?? 0)));
  const sponsored = BigInt(Math.max(0, Math.trunc(account?.num_sponsored ?? 0)));
  const reserves = MIN_ACCOUNT_RESERVES + subentries + sponsoring - sponsored;
  return (reserves < MIN_ACCOUNT_RESERVES ? MIN_ACCOUNT_RESERVES : reserves) *
    BASE_RESERVE_STROOPS;
}

/** Reads token and XLM balances out of a Horizon `/accounts/{id}` payload. */
export function parseHorizonAccount(
  payload: HorizonAccountResponse | null | undefined,
  asset?: AssetRef
): TokenBalanceSnapshot {
  const balances = Array.isArray(payload?.balances) ? payload?.balances ?? [] : [];
  const native = balances.find((entry) => entry.asset_type === "native");
  const xlmBalance = parseAmountToBaseUnits(native?.balance);

  const code = asset?.code?.trim();
  const isNative = !code || code.toUpperCase() === "XLM";
  const tokenEntry = isNative
    ? native
    : balances.find(
        (entry) =>
          entry.asset_code?.toUpperCase() === code?.toUpperCase() &&
          (!asset?.issuer || entry.asset_issuer === asset.issuer)
      );

  const tokenBalance = isNative
    ? xlmBalance
    : parseAmountToBaseUnits(tokenEntry?.balance);

  const reserve = minimumXlmReserve(payload);
  const availableXlm = xlmBalance > reserve ? xlmBalance - reserve : 0n;

  return {
    tokenBalance,
    tokenFound: Boolean(tokenEntry),
    xlmBalance,
    minimumXlmReserve: reserve,
    availableXlm,
  };
}

/**
 * Decides whether the payer can submit for the requested amount, and builds the
 * inline message shown when they cannot.
 */
export function evaluateBalance(
  snapshot: TokenBalanceSnapshot | null,
  requiredTokenBaseUnits: bigint,
  options: { tokenSymbol?: string; requiredXlmFeeStroops?: bigint } = {}
): BalanceCheck {
  if (!snapshot) {
    return {
      sufficient: false,
      reason: "unavailable",
      alert: "Unable to verify your wallet balance. Please retry before submitting.",
    };
  }

  const symbol = options.tokenSymbol || "tokens";
  const fee = options.requiredXlmFeeStroops ?? 0n;

  if (requiredTokenBaseUnits > 0n && snapshot.tokenBalance < requiredTokenBaseUnits) {
    return {
      sufficient: false,
      reason: "insufficient-token",
      alert: `Insufficient ${symbol} balance: ${formatBaseUnits(
        requiredTokenBaseUnits
      )} required, ${formatBaseUnits(snapshot.tokenBalance)} available.`,
    };
  }

  if (fee > snapshot.availableXlm) {
    return {
      sufficient: false,
      reason: "insufficient-xlm",
      alert: `Insufficient XLM: ${formatBaseUnits(
        fee
      )} needed for network fees, ${formatBaseUnits(
        snapshot.availableXlm
      )} available above the ${formatBaseUnits(snapshot.minimumXlmReserve)} XLM reserve.`,
    };
  }

  return { sufficient: true, reason: null, alert: null };
}

export function isAccountFunded(snapshot: TokenBalanceSnapshot): boolean {
  return snapshot.xlmBalance >= snapshot.minimumXlmReserve;
}

/** Fetches the raw Horizon account record (balances + reserve inputs). */
export async function fetchAccountBalances(
  horizonUrl: string,
  account: string
): Promise<HorizonAccountResponse> {
  const base = horizonUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/accounts/${encodeURIComponent(account)}`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Horizon balance lookup failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as HorizonAccountResponse;
  if (!payload || !Array.isArray(payload.balances)) {
    throw new Error("Horizon returned a malformed account record");
  }
  return payload;
}

export interface UseTokenBalanceOptions {
  /** Payer wallet address; pass null/undefined while disconnected. */
  account: string | null | undefined;
  /** Token to watch. Omit (or use XLM) for the native asset. */
  asset?: AssetRef;
  /** Amount the form is about to spend, in base units. */
  amountBaseUnits?: bigint;
  /** Network fee the transaction needs, in stroops. */
  requiredXlmFeeStroops?: bigint;
  /** Symbol used in inline alerts (e.g. "USDC"). */
  tokenSymbol?: string;
  horizonUrl?: string;
  /** Change this value to force a refresh (e.g. after a confirmed transaction). */
  refreshKey?: unknown;
}

export interface UseTokenBalanceResult {
  snapshot: TokenBalanceSnapshot | null;
  check: BalanceCheck;
  loading: boolean;
  error: string | null;
  /** True when submit is allowed: wallet connected, balances loaded, funds sufficient. */
  canSubmit: boolean;
  /** Inline alert text, or null when nothing needs to be shown. */
  alert: string | null;
  /** Re-reads balances from Horizon. Call after a successful submission. */
  refresh: () => void;
}

export function useTokenBalance(
  options: UseTokenBalanceOptions
): UseTokenBalanceResult {
  const {
    account,
    asset,
    amountBaseUnits = 0n,
    requiredXlmFeeStroops = 0n,
    tokenSymbol,
    horizonUrl = DEFAULT_HORIZON_URL,
    refreshKey,
  } = options;

  const [result, setResult] = useState<{
    key: string;
    snapshot: TokenBalanceSnapshot | null;
    error: string | null;
  } | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  const assetCode = asset?.code;
  const assetIssuer = asset?.issuer;

  /**
   * Identity of the balance lookup currently requested. Changing it starts a
   * new fetch, so pending state is derived by comparing it with the result
   * that has been stored rather than by setting state synchronously in the
   * effect body.
   */
  const requestKey = JSON.stringify([
    account ?? null,
    horizonUrl,
    assetCode ?? null,
    assetIssuer ?? null,
    String(nonce),
    String(refreshKey ?? null),
  ]);

  useEffect(() => {
    if (!account) return;

    let cancelled = false;
    const key = requestKey;

    fetchAccountBalances(horizonUrl, account)
      .then((payload) => {
        if (cancelled) return;
        setResult({
          key,
          snapshot: parseHorizonAccount(payload, { code: assetCode, issuer: assetIssuer }),
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResult({
          key,
          snapshot: null,
          error: err instanceof Error ? err.message : "Balance lookup failed",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [account, horizonUrl, assetCode, assetIssuer, requestKey]);

  const settled = result && result.key === requestKey ? result : null;
  const snapshot = account ? settled?.snapshot ?? null : null;
  const error = account ? settled?.error ?? null : null;
  const loading = Boolean(account) && settled === null;

  // With no wallet connected the hook reports the empty state directly, so the
  // effect never has to reset state synchronously before fetching.
  const activeSnapshot = account ? snapshot : null;
  const activeError = account ? error : null;
  const activeLoading = account ? loading : false;

  const check: BalanceCheck = !account
    ? { sufficient: false, reason: "no-wallet", alert: null }
    : activeLoading
      ? { sufficient: false, reason: null, alert: null }
      : evaluateBalance(snapshot, amountBaseUnits, {
          tokenSymbol,
          requiredXlmFeeStroops,
        });

  return {
    snapshot: activeSnapshot,
    check,
    loading: activeLoading,
    error: activeError,
    canSubmit:
      Boolean(account) && !activeLoading && !activeError && check.sufficient,
    alert: activeError
      ? `Balance lookup failed: ${activeError}`
      : check.alert,
    refresh,
  };
}
