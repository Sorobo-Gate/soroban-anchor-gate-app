"use client";

import * as React from "react";
import { SorobanDataBuilder, Transaction, rpc } from "@stellar/stellar-sdk";
import { AlertTriangle, Cpu, Database, Coins, ShieldCheck, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trapDialogFocus } from "@/lib/a11y";

/**
 * Pre-flight simulation modal.
 *
 * Flow: build tx → {@link runPreflightSimulation} (Soroban `simulateTransaction`) →
 * show cost breakdown or a plain-language revert explanation → only on explicit user
 * confirmation does the caller trigger the Freighter signing popup.
 */

export const STROOPS_PER_XLM = 10_000_000n;

/** Mirrors `contracts/src/errors.rs::EscrowError` (repr u32). */
export const ESCROW_CONTRACT_ERRORS: Record<number, { name: string; explanation: string }> = {
  1: { name: "NotInitialized", explanation: "The escrow contract has not been initialised on this network yet." },
  2: { name: "AlreadyInitialized", explanation: "The escrow contract is already initialised." },
  3: { name: "Unauthorized", explanation: "Your wallet is not authorised to perform this action on the escrow." },
  4: { name: "EscrowNotFound", explanation: "No escrow exists with this ID. Double-check the escrow number." },
  5: { name: "InvalidStatus", explanation: "The escrow is not in a state that allows this action (it may already be released, refunded or disputed)." },
  6: { name: "UnlockTimeNotReached", explanation: "The escrow lock period has not ended yet, so funds cannot be refunded." },
  7: { name: "UnlockTimePassed", explanation: "The escrow lock period has already ended, so this action is no longer allowed." },
  8: { name: "ZeroAmount", explanation: "The amount must be greater than zero." },
  9: { name: "InvalidBps", explanation: "The basis-point split is invalid; it must be between 0 and 10,000." },
  10: { name: "ArithmeticOverflow", explanation: "The amount is too large and caused an arithmetic overflow in the contract." },
  11: { name: "TokenNotWhitelisted", explanation: "This token is not on the contract's allow-list. Choose a supported asset." },
  12: { name: "InvalidDisputeSplit", explanation: "The dispute split must add up to exactly 100% (10,000 basis points)." },
  13: { name: "EmptyDisbursement", explanation: "The disbursement list is empty." },
  14: { name: "TooManyDisbursements", explanation: "Too many disbursement recipients were supplied in one transaction." },
  15: { name: "InvalidDisbursementAmount", explanation: "One of the disbursement amounts is invalid." },
  16: { name: "DisbursementMismatch", explanation: "The disbursement amounts do not add up to the escrowed total." },
  17: { name: "ClawbackNotAllowed", explanation: "Clawback is not permitted for this escrow." },
  18: { name: "ProposalNotFound", explanation: "The referenced admin proposal does not exist." },
  19: { name: "ProposalAlreadyExecuted", explanation: "This admin proposal has already been executed." },
  20: { name: "CannotConfirmOwnProposal", explanation: "You cannot confirm a proposal you created yourself." },
  21: { name: "AdminAlreadyExists", explanation: "This address is already an admin." },
  22: { name: "CannotRemoveLastAdmin", explanation: "The last remaining admin cannot be removed." },
  23: { name: "AdminNotFound", explanation: "The specified admin address was not found." },
  24: { name: "MigrationFailed", explanation: "The contract storage migration failed." },
  25: { name: "HourlyVolumeLimitExceeded", explanation: "The hourly escrow volume limit has been reached. Try a smaller amount or wait and retry later." },
  26: { name: "InvalidVolumeLimit", explanation: "The configured volume limit is invalid." },
  27: { name: "ReentrancyDetected", explanation: "The contract blocked a re-entrant call. Retry the action without nesting escrow calls." },
  28: { name: "InvalidPreimage", explanation: "The supplied preimage does not match this escrow's hashlock, so the release cannot proceed." },
  29: { name: "HashlockNotSet", explanation: "This escrow has no hashlock configured, so hashlock release is unavailable." },
  30: { name: "SecondaryBeneficiaryNotFound", explanation: "The escrow's secondary beneficiary could not be found, so fallback routing cannot be applied." },
};

/** Explanations for Soroban host error categories (`Error(<Type>, <Code>)`). */
const HOST_ERROR_EXPLANATIONS: Record<string, string> = {
  Auth: "A required signature or authorisation is missing. Make sure the connected wallet is the party allowed to perform this action.",
  Budget: "The transaction would exceed the network's CPU or memory limits.",
  Storage: "A required ledger entry is missing or archived (for example the escrow, token balance, or contract data).",
  WasmVm: "The contract trapped while executing — the call arguments are likely invalid for this contract.",
  Value: "One of the call arguments has an invalid value or type.",
  Object: "The contract received an invalid object reference.",
  Crypto: "A cryptographic check (hash or signature) failed.",
  Events: "The contract emitted an invalid event.",
  Context: "The contract was invoked in an invalid context.",
};

export interface SimulationErrorExplanation {
  title: string;
  explanation: string;
  /** e.g. "Contract #4" or "Auth/InvalidAction" */
  code?: string;
  category: "contract" | "host" | "balance" | "account" | "network" | "unknown";
  raw: string;
}

/** Translates a raw Soroban simulation / RPC error into plain language. */
export function explainSimulationError(raw: string | undefined | null): SimulationErrorExplanation {
  const text = (raw ?? "").toString().trim();
  const base = { raw: text };

  const contract = /Error\(\s*Contract\s*,\s*#?(\d+)\s*\)/i.exec(text);
  if (contract) {
    const code = Number(contract[1]);
    const known = ESCROW_CONTRACT_ERRORS[code];
    return {
      ...base,
      category: "contract",
      code: `Contract #${code}`,
      title: known ? `Contract rejected the transaction: ${known.name}` : `Contract rejected the transaction (error #${code})`,
      explanation: known
        ? known.explanation
        : "The escrow contract reverted with an unrecognised error code. No funds will move if you do not sign.",
    };
  }

  const host = /Error\(\s*(\w+)\s*,\s*(\w+)\s*\)/.exec(text);
  if (host && HOST_ERROR_EXPLANATIONS[host[1]]) {
    const [, type, code] = host;
    let explanation = HOST_ERROR_EXPLANATIONS[type];
    if (type === "Storage" && /MissingValue/i.test(code)) {
      explanation = "A required ledger entry was not found — the escrow ID may not exist, or contract data has been archived and must be restored.";
    } else if (type === "Budget" && /ExceededLimit/i.test(code)) {
      explanation = "This transaction exceeds Soroban's per-transaction CPU/memory budget and cannot be executed as-is.";
    }
    return { ...base, category: "host", code: `${type}/${code}`, title: `Soroban host error: ${type}`, explanation };
  }

  if (/insufficient|underfunded|balance is not sufficient|resulting balance/i.test(text)) {
    return {
      ...base,
      category: "balance",
      title: "Insufficient balance",
      explanation: "Your wallet does not hold enough of this token (or XLM for fees) to complete the transaction.",
    };
  }
  if (/account not found|Account not found|404/i.test(text)) {
    return {
      ...base,
      category: "account",
      title: "Account not found on network",
      explanation: "The source account does not exist on this network yet. Fund it with XLM (e.g. via Friendbot on Testnet) first.",
    };
  }
  if (/fetch failed|network|timeout|ECONN|socket/i.test(text)) {
    return {
      ...base,
      category: "network",
      title: "Could not reach Soroban RPC",
      explanation: "The simulation request did not complete. Check your connection and try again.",
    };
  }
  return {
    ...base,
    category: "unknown",
    title: "Simulation failed",
    explanation: text
      ? "The network rejected this transaction during simulation. It would fail on-chain, so you have not been asked to sign it."
      : "The simulation failed without an error message.",
  };
}

export interface SimulationCostSummary {
  cpuInstructions: number;
  diskReadBytes: number;
  writeBytes: number;
  /** Total ledger I/O footprint (read + write bytes). */
  memoryFootprintBytes: number;
  readOnlyEntries: number;
  readWriteEntries: number;
  resourceFeeStroops: bigint;
  inclusionFeeStroops: bigint;
  totalFeeStroops: bigint;
  totalFeeXlm: string;
  /** True when archived entries must be restored before this tx can succeed. */
  requiresRestore: boolean;
}

/** Converts stroops to a 7-decimal XLM string without floating-point error. */
export function stroopsToXlm(stroops: bigint | string | number): string {
  const value = BigInt(stroops);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / STROOPS_PER_XLM;
  const frac = (abs % STROOPS_PER_XLM).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Formats large integers with thousands separators (locale-independent for stable tests). */
export function formatCount(value: number): string {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Human-readable byte size (B / KB / MB, base 1024). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Extracts the resource breakdown from a successful simulation.
 * `inclusionFee` is the transaction's base (inclusion) fee in stroops.
 */
export function summarizeSimulation(
  sim: rpc.Api.SimulateTransactionSuccessResponse,
  inclusionFee: bigint | string | number = 100
): SimulationCostSummary {
  const data = sim.transactionData instanceof SorobanDataBuilder ? sim.transactionData.build() : null;
  const resources = data?.resources;
  const footprint = resources?.footprint;
  const diskReadBytes = Number(resources?.diskReadBytes ?? 0);
  const writeBytes = Number(resources?.writeBytes ?? 0);
  const resourceFeeStroops = BigInt(sim.minResourceFee || "0");
  const inclusionFeeStroops = BigInt(inclusionFee);
  const totalFeeStroops = resourceFeeStroops + inclusionFeeStroops;
  return {
    cpuInstructions: Number(resources?.instructions ?? 0),
    diskReadBytes,
    writeBytes,
    memoryFootprintBytes: diskReadBytes + writeBytes,
    readOnlyEntries: footprint?.readOnly.length ?? 0,
    readWriteEntries: footprint?.readWrite.length ?? 0,
    resourceFeeStroops,
    inclusionFeeStroops,
    totalFeeStroops,
    totalFeeXlm: stroopsToXlm(totalFeeStroops),
    requiresRestore: rpc.Api.isSimulationRestore(sim),
  };
}

export type PreflightResult =
  | { ok: true; summary: SimulationCostSummary; preparedTx: Transaction }
  | { ok: false; error: SimulationErrorExplanation };

/** Minimal RPC surface needed for simulation (lets tests inject a fake server). */
export interface SimulationServer {
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
}

/**
 * Runs Soroban simulation *before* any wallet interaction. Never throws:
 * reverts, restore requirements and transport failures are all returned as data.
 */
export async function runPreflightSimulation(
  server: SimulationServer,
  tx: Transaction,
  assemble: (tx: Transaction, sim: rpc.Api.SimulateTransactionSuccessResponse) => Transaction = (t, s) =>
    rpc.assembleTransaction(t, s).build()
): Promise<PreflightResult> {
  let sim: rpc.Api.SimulateTransactionResponse;
  try {
    sim = await server.simulateTransaction(tx);
  } catch (err: unknown) {
    return { ok: false, error: explainSimulationError(err instanceof Error ? err.message : String(err)) };
  }

  if (rpc.Api.isSimulationError(sim)) {
    return { ok: false, error: explainSimulationError(sim.error) };
  }
  if (!rpc.Api.isSimulationSuccess(sim)) {
    return { ok: false, error: explainSimulationError("Simulation did not return a successful result") };
  }
  if (rpc.Api.isSimulationRestore(sim)) {
    return {
      ok: false,
      error: {
        category: "host",
        code: "Storage/Archived",
        title: "Archived contract data must be restored first",
        explanation:
          "Some ledger entries this transaction needs have been archived. A restore transaction must be submitted before this action can succeed.",
        raw: "restorePreamble present",
      },
    };
  }

  try {
    const preparedTx = assemble(tx, sim);
    return { ok: true, summary: summarizeSimulation(sim, tx.fee), preparedTx };
  } catch (err: unknown) {
    return { ok: false, error: explainSimulationError(err instanceof Error ? err.message : String(err)) };
  }
}

export type SimulationModalState =
  | { phase: "simulating" }
  | { phase: "ready"; summary: SimulationCostSummary }
  | { phase: "reverted"; error: SimulationErrorExplanation };

/** Builds the label/value rows of the cost breakdown (pure, for rendering and tests). */
export function buildCostRows(summary: SimulationCostSummary): Array<{ label: string; value: string; hint: string }> {
  return [
    {
      label: "CPU instructions",
      value: formatCount(summary.cpuInstructions),
      hint: "Soroban VM instructions consumed",
    },
    {
      label: "Memory / ledger footprint",
      value: formatBytes(summary.memoryFootprintBytes),
      hint: `${formatBytes(summary.diskReadBytes)} read · ${formatBytes(summary.writeBytes)} written · ${summary.readOnlyEntries + summary.readWriteEntries} ledger entries`,
    },
    {
      label: "Estimated network fee",
      value: `${summary.totalFeeXlm} XLM`,
      hint: `${stroopsToXlm(summary.resourceFeeStroops)} resource + ${stroopsToXlm(summary.inclusionFeeStroops)} inclusion`,
    },
  ];
}

export interface SimulationModalProps {
  open: boolean;
  state: SimulationModalState;
  /** Short description of the action, e.g. "escrow deposit (100 XLM)". */
  actionLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional content shown after a successful simulation (e.g. a scan-to-sign QR code). */
  readyExtra?: React.ReactNode;
}

const ROW_ICONS = [Cpu, Database, Coins];

export function SimulationModal({ open, state, actionLabel, onConfirm, onCancel, readyExtra }: SimulationModalProps) {
  const titleId = React.useId();
  const descId = React.useId();
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const previousFocusRef = React.useRef<HTMLElement | null>(null);
  const primaryRef = React.useRef<HTMLButtonElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
      return;
    }
    if (!previousFocusRef.current && document.activeElement instanceof HTMLElement) {
      previousFocusRef.current = document.activeElement;
    }
    const target = state.phase === "ready" ? primaryRef.current : cancelRef.current;
    target?.focus();
  }, [open, state.phase]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      trapDialogFocus(dialogRef.current, e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center" data-testid="simulation-modal">
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" aria-hidden="true" onClick={onCancel} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="relative w-full max-w-lg rounded-t-2xl border border-border bg-card p-6 shadow-2xl sm:rounded-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-foreground">
              {state.phase === "reverted" ? "Transaction would fail" : "Review transaction pre-flight"}
            </h2>
            <p id={descId} className="mt-1 text-xs text-muted-foreground">
              Simulated {actionLabel} on Soroban before requesting your wallet signature.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {state.phase === "simulating" && (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Simulating transaction on Soroban RPC…
          </div>
        )}

        {state.phase === "reverted" && (
          <div
            role="alert"
            data-testid="simulation-revert"
            className="rounded-xl border-2 border-destructive/60 bg-destructive/10 p-4 text-sm"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-semibold text-destructive">{state.error.title}</p>
                <p className="mt-1 text-foreground">{state.error.explanation}</p>
                {state.error.code && (
                  <p className="mt-2 font-mono text-[11px] text-muted-foreground">Code: {state.error.code}</p>
                )}
                {state.error.raw && (
                  <details className="mt-2 text-[11px] text-muted-foreground">
                    <summary className="cursor-pointer">Technical details</summary>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono">{state.error.raw}</pre>
                  </details>
                )}
                <p className="mt-3 text-xs text-muted-foreground">
                  You have not been asked to sign anything and no funds have moved.
                </p>
              </div>
            </div>
          </div>
        )}

        {state.phase === "ready" && (
          <>
            <ul className="space-y-2" data-testid="simulation-breakdown">
              {buildCostRows(state.summary).map((row, i) => {
                const Icon = ROW_ICONS[i];
                return (
                  <li key={row.label} className="flex items-start gap-3 rounded-xl border border-border bg-muted/30 p-3">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-xs text-muted-foreground">{row.label}</span>
                        <span className="font-mono text-sm font-semibold text-foreground">{row.value}</span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{row.hint}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
              Simulation succeeded. Fees are estimates and may vary slightly at submission.
            </p>
            {readyExtra && <div className="mt-4">{readyExtra}</div>}
          </>
        )}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button ref={cancelRef} type="button" variant="outline" onClick={onCancel} className="min-h-12">
            {state.phase === "reverted" ? "Close" : "Cancel"}
          </Button>
          {state.phase !== "reverted" && (
            <Button
              ref={primaryRef}
              type="button"
              onClick={onConfirm}
              disabled={state.phase !== "ready"}
              className="min-h-12"
            >
              Continue to wallet signature
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default SimulationModal;
