"use client";

import * as React from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Scale } from "lucide-react";

export const MAX_BPS = 10000;
export const SLIDER_STEP = 500;
export const DEFAULT_PAYER_BPS = 6000;

export interface DisputeSplit {
  payerPct: number;
  beneficiaryPct: number;
}

export interface SplitValidation {
  valid: boolean;
  error?: string;
}

export interface DisputeEvidence {
  url: string;
  description: string;
}

export type DisputeStatus = "idle" | "submitting" | "success" | "error";

export interface DisputeState {
  escrowId: string;
  payer: string;
  beneficiary: string;
  payerClaim: string;
  beneficiaryClaim: string;
  evidence: DisputeEvidence[];
  payerBps: number;
  beneficiaryBps: number;
  status: DisputeStatus;
  error: string | null;
  txHash: string | null;
}

export type DisputeAction =
  | { type: "setRatio"; payerBps: number }
  | { type: "submitRequest" }
  | { type: "submitSuccess"; txHash: string }
  | { type: "submitFailure"; error: string }
  | { type: "reset" }
  | { type: "addEvidence"; evidence: DisputeEvidence };

export function computeSplit(payerBps: number): DisputeSplit {
  const p = Math.min(Math.max(payerBps, 0), MAX_BPS);
  return { payerPct: p / 100, beneficiaryPct: (MAX_BPS - p) / 100 };
}

export function validateSplit(
  payerBps: number,
  beneficiaryBps: number
): SplitValidation {
  if (payerBps < 0 || beneficiaryBps < 0) {
    return { valid: false, error: "Shares must be non-negative" };
  }
  if (payerBps + beneficiaryBps !== MAX_BPS) {
    return {
      valid: false,
      error: `Shares must sum to 100% (${MAX_BPS} basis points)`,
    };
  }
  return { valid: true };
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function initialDisputeState(
  overrides?: Partial<DisputeState>
): DisputeState {
  const state: DisputeState = {
    escrowId: "3",
    payer: "GAAAAA1111111111111111111111111111111111111111111111111111",
    beneficiary: "GBBBBB2222222222222222222222222222222222222222222222222222",
    payerClaim:
      "The beneficiary failed to deliver the agreed milestone by the deadline.",
    beneficiaryClaim:
      "The work was completed per contract; the payer released funds prematurely.",
    evidence: [
      {
        url: "https://example.com/evidence/invoice-1024.pdf",
        description: "Milestone invoice",
      },
      {
        url: "https://example.com/evidence/delivery-proof.pdf",
        description: "Delivery proof",
      },
    ],
    payerBps: DEFAULT_PAYER_BPS,
    beneficiaryBps: MAX_BPS - DEFAULT_PAYER_BPS,
    status: "idle",
    error: null,
    txHash: null,
  };
  const merged = { ...state, ...overrides };
  return { ...merged, beneficiaryBps: MAX_BPS - merged.payerBps };
}

export function disputeReducer(state: DisputeState, action: DisputeAction): DisputeState {
  switch (action.type) {
    case "setRatio": {
      const payerBps = Math.min(Math.max(action.payerBps, 0), MAX_BPS);
      return {
        ...state,
        payerBps,
        beneficiaryBps: MAX_BPS - payerBps,
        status: "idle",
        error: null,
      };
    }
    case "submitRequest":
      return { ...state, status: "submitting", error: null, txHash: null };
    case "submitSuccess":
      return { ...state, status: "success", txHash: action.txHash, error: null };
    case "submitFailure":
      return { ...state, status: "error", error: action.error, txHash: null };
    case "addEvidence":
      return { ...state, evidence: [...state.evidence, action.evidence] };
    case "reset":
      return initialDisputeState();
    default:
      return state;
  }
}

export interface DisputeSliderProps {
  payerBps: number;
  onChange: (payerBps: number) => void;
  className?: string;
}

export function DisputeSlider({
  payerBps,
  onChange,
  className,
}: DisputeSliderProps) {
  const { payerPct, beneficiaryPct } = computeSplit(payerBps);
  const sliderId = React.useId();
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Scale className="w-4 h-4 text-primary" aria-hidden="true" />
          Settlement Split
        </CardTitle>
        <CardDescription>
          Adjust how the contested escrow is divided between payer and beneficiary.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Payer share</span>
            <span className="font-semibold text-foreground">{payerPct.toFixed(2)}%</span>
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Beneficiary share</span>
            <span className="font-semibold text-foreground">{beneficiaryPct.toFixed(2)}%</span>
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor={sliderId} className="sr-only">
            Settlement split percentage for payer
          </label>
          <input
            id={sliderId}
            type="range"
            min="0"
            max={MAX_BPS}
            step={SLIDER_STEP}
            value={payerBps}
            onChange={(e) => onChange(Number(e.target.value))}
            aria-label="Settlement split percentage for payer"
            aria-valuemin={0}
            aria-valuemax={MAX_BPS}
            aria-valuenow={payerBps}
            aria-valuetext={`${payerPct.toFixed(0)}% payer, ${beneficiaryPct.toFixed(0)}% beneficiary`}
            className="w-full accent-primary h-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground font-mono" aria-hidden="true">
            <span>0%</span>
            <span>50%</span>
            <span>100%</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The split is encoded in basis points and must sum to 100%.
        </p>
      </CardContent>
    </Card>
  );
}

DisputeSlider.displayName = "DisputeSlider";
