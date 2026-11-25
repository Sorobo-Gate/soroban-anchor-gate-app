"use client";

import * as React from "react";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  RotateCcw,
  Timer,
} from "lucide-react";
import {
  formatTxHash,
  getStellarExpertUrl,
  type StellarNetwork,
} from "@/components/ui/Toast";

export type EscrowTimelineStatus =
  | "Created"
  | "Funded"
  | "Processing"
  | "Disbursed"
  | "Completed"
  | "Refunded"
  | "Disputed";

export type TimelineStepId =
  | "created"
  | "funded"
  | "processing"
  | "disbursed"
  | "completed";

export type TimelineStepState = "complete" | "active" | "pending";

export type RelayStatus = "idle" | "pending" | "confirmed" | "failed";

export interface TimelineStep {
  id: TimelineStepId;
  label: string;
  description: string;
}

export const ESCROW_TIMELINE_STEPS: readonly TimelineStep[] = [
  { id: "created", label: "Created", description: "Escrow terms committed on-chain" },
  { id: "funded", label: "Funded", description: "Payer tokens locked in the contract" },
  { id: "processing", label: "Processing", description: "Anchor relay is settling fiat" },
  { id: "disbursed", label: "Disbursed", description: "Funds released to the anchor" },
  { id: "completed", label: "Completed", description: "Beneficiary payout confirmed" },
];

export const TERMINAL_ESCROW_STATUSES: readonly EscrowTimelineStatus[] = [
  "Refunded",
  "Disputed",
];

export interface TimelineProgress {
  /** Index of the pulsing active step, or null when lifecycle has ended. */
  activeIndex: number | null;
  /** Number of steps that have already completed. */
  completedCount: number;
  terminal: "Refunded" | "Disputed" | null;
  completed: boolean;
}

const STATUS_PROGRESS: Record<EscrowTimelineStatus, TimelineProgress> = {
  Created: { activeIndex: 0, completedCount: 0, terminal: null, completed: false },
  Funded: { activeIndex: 1, completedCount: 1, terminal: null, completed: false },
  Processing: { activeIndex: 2, completedCount: 2, terminal: null, completed: false },
  Disbursed: { activeIndex: 3, completedCount: 3, terminal: null, completed: false },
  Completed: {
    activeIndex: null,
    completedCount: ESCROW_TIMELINE_STEPS.length,
    terminal: null,
    completed: true,
  },
  Refunded: { activeIndex: null, completedCount: 1, terminal: "Refunded", completed: true },
  Disputed: { activeIndex: null, completedCount: 1, terminal: "Disputed", completed: true },
};

export function getTimelineProgress(status: EscrowTimelineStatus): TimelineProgress {
  return STATUS_PROGRESS[status];
}

export function getTimelineStepState(
  status: EscrowTimelineStatus,
  index: number
): TimelineStepState {
  const progress = getTimelineProgress(status);
  if (index < progress.completedCount) {
    return "complete";
  }
  if (progress.activeIndex !== null && index === progress.activeIndex) {
    return "active";
  }
  return "pending";
}

export function isTerminalEscrowStatus(status: EscrowTimelineStatus): boolean {
  return TERMINAL_ESCROW_STATUSES.includes(status);
}

const RELAY_LABELS: Record<RelayStatus, string> = {
  idle: "Relay idle",
  pending: "Relay settling fiat",
  confirmed: "Relay confirmed",
  failed: "Relay failed",
};

const RELAY_CLASSES: Record<RelayStatus, string> = {
  idle: "border-border bg-input/50 text-muted-foreground",
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  confirmed: "border-primary/30 bg-primary/10 text-primary",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
};

export interface EscrowTimelineProps {
  /** On-chain escrow status as reported by the contract / relay. */
  status: EscrowTimelineStatus;
  /** Transaction hash per lifecycle step, linked to Stellar Expert. */
  txHashes?: Partial<Record<TimelineStepId, string>>;
  /** Off-chain anchor relay state displayed alongside the on-chain steps. */
  relayStatus?: RelayStatus;
  network?: StellarNetwork;
  escrowId?: string | number;
  className?: string;
}

const SVG_WIDTH = 900;
const SVG_HEIGHT = 150;
const NODE_Y = 58;
const NODE_RADIUS = 18;
const PADDING_X = 90;
const STEP_GAP =
  (SVG_WIDTH - PADDING_X * 2) / (ESCROW_TIMELINE_STEPS.length - 1);

function stepCenterX(index: number): number {
  return PADDING_X + index * STEP_GAP;
}

function nodeClasses(state: TimelineStepState): string {
  switch (state) {
    case "complete":
      return "fill-primary stroke-primary";
    case "active":
      return "fill-card stroke-primary";
    case "pending":
      return "fill-card stroke-border";
  }
}

function labelClasses(state: TimelineStepState): string {
  switch (state) {
    case "complete":
      return "fill-primary font-semibold";
    case "active":
      return "fill-foreground font-semibold";
    case "pending":
      return "fill-muted-foreground";
  }
}

function connectorClasses(state: TimelineStepState): string {
  return state === "pending" ? "stroke-border" : "stroke-primary";
}

export function EscrowTimeline({
  status,
  txHashes = {},
  relayStatus = "idle",
  network = "testnet",
  escrowId,
  className = "",
}: EscrowTimelineProps) {
  const progress = getTimelineProgress(status);
  const terminalLabel = progress.terminal;

  return (
    <section
      className={`rounded-2xl border border-border bg-card p-5 shadow-sm ${className}`}
      data-testid="escrow-timeline"
      data-status={status}
      aria-label={escrowId !== undefined ? `Escrow ${escrowId} lifecycle` : "Escrow lifecycle"}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            Escrow Lifecycle
            {escrowId !== undefined && (
              <span className="ml-2 font-mono text-xs text-muted-foreground">#{escrowId}</span>
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            On-chain and relay progress for this remittance.
          </p>
        </div>
        <span
          className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${RELAY_CLASSES[relayStatus]}`}
          data-testid="relay-status"
          data-relay-status={relayStatus}
        >
          <Timer className="h-3 w-3" aria-hidden="true" />
          {RELAY_LABELS[relayStatus]}
        </span>
      </div>

      <div className="mt-4 overflow-x-auto">
        <svg
          viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
          className="h-[150px] min-w-[680px] w-full"
          role="img"
          aria-label={`Escrow status: ${status}`}
          data-testid="escrow-timeline-svg"
        >
          <title>{`Escrow lifecycle: ${status}`}</title>
          {ESCROW_TIMELINE_STEPS.slice(0, -1).map((step, index) => {
            const nextState = getTimelineStepState(status, index + 1);
            const x1 = stepCenterX(index) + NODE_RADIUS;
            const x2 = stepCenterX(index + 1) - NODE_RADIUS;
            return (
              <line
                key={`connector-${step.id}`}
                x1={x1}
                y1={NODE_Y}
                x2={x2}
                y2={NODE_Y}
                strokeWidth={3}
                strokeLinecap="round"
                className={connectorClasses(nextState)}
                data-testid={`timeline-connector-${step.id}`}
              />
            );
          })}

          {ESCROW_TIMELINE_STEPS.map((step, index) => {
            const state = getTimelineStepState(status, index);
            const x = stepCenterX(index);
            return (
              <g
                key={step.id}
                data-testid={`timeline-step-${step.id}`}
                data-state={state}
              >
                <title>{`${step.label}: ${state}`}</title>
                {state === "active" && (
                  <circle
                    cx={x}
                    cy={NODE_Y}
                    r={NODE_RADIUS + 9}
                    className="fill-primary/20 stroke-primary animate-pulse"
                    strokeWidth={2}
                    data-testid={`timeline-pulse-${step.id}`}
                  />
                )}
                <circle
                  cx={x}
                  cy={NODE_Y}
                  r={NODE_RADIUS}
                  strokeWidth={3}
                  className={nodeClasses(state)}
                />
                {state === "complete" ? (
                  <path
                    d={`M ${x - 6} ${NODE_Y} l 4 4 l 8 -8`}
                    fill="none"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="stroke-primary-foreground"
                  />
                ) : (
                  <text
                    x={x}
                    y={NODE_Y + 4}
                    textAnchor="middle"
                    className={`text-[11px] ${labelClasses(state)}`}
                    data-testid={`timeline-index-${step.id}`}
                  >
                    {index + 1}
                  </text>
                )}
                <text
                  x={x}
                  y={NODE_Y + 42}
                  textAnchor="middle"
                  className={`text-[13px] ${labelClasses(state)}`}
                >
                  {step.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {terminalLabel && (
        <div
          className="mt-1 flex items-start gap-3 rounded-xl border border-border bg-input/40 p-3 text-xs"
          data-testid="timeline-terminal"
          data-terminal={terminalLabel}
        >
          {terminalLabel === "Refunded" ? (
            <RotateCcw className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          )}
          <div>
            <span className="block font-semibold text-foreground">
              {terminalLabel === "Refunded"
                ? "Escrow refunded to payer"
                : "Escrow held for dispute resolution"}
            </span>
            <span className="text-muted-foreground">
              {terminalLabel === "Refunded"
                ? "The escrow timeout elapsed before disbursement, so the payer reclaimed the locked funds."
                : "An arbiter is reviewing the escrow and will settle it on-chain."}
            </span>
          </div>
        </div>
      )}

      <ol className="mt-4 space-y-2" aria-label="Lifecycle transaction hashes">
        {ESCROW_TIMELINE_STEPS.map((step, index) => {
          const hash = txHashes[step.id]?.trim();
          const state = getTimelineStepState(status, index);
          return (
            <li
              key={`tx-${step.id}`}
              className="flex flex-col gap-1 rounded-lg border border-border/70 bg-input/20 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              data-testid={`timeline-tx-row-${step.id}`}
              data-state={state}
            >
              <div className="flex items-center gap-2 text-xs">
                {state === "complete" ? (
                  <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" aria-hidden="true" />
                )}
                <span className={state === "pending" ? "text-muted-foreground" : "text-foreground"}>
                  {step.label}
                </span>
                <span className="hidden text-[11px] text-muted-foreground sm:inline">
                  — {step.description}
                </span>
              </div>
              {hash ? (
                <a
                  href={getStellarExpertUrl(hash, network)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex w-fit items-center gap-1 font-mono text-[11px] text-primary hover:underline"
                  aria-label={`View ${step.label} transaction on Stellar Expert`}
                  data-testid={`timeline-tx-link-${step.id}`}
                >
                  {formatTxHash(hash)}
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ) : (
                <span
                  className="font-mono text-[11px] text-muted-foreground"
                  data-testid={`timeline-tx-empty-${step.id}`}
                >
                  No transaction yet
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
