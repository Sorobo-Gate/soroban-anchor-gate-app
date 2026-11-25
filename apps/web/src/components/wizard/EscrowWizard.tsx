"use client";

import React, { useEffect, useReducer, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  LAST_STEP,
  WIZARD_STEPS,
  WizardState,
  initialWizardState,
  validateStep,
  wizardReducer,
} from "@/lib/wizard";

export interface TokenOption {
  label: string;
  address: string;
}

export interface EscrowWizardProps {
  walletAddress: string;
  tokens: TokenOption[];
  /** Resolves the payer's balance (base units) for a token, or null if unavailable. */
  fetchBalance: (token: string) => Promise<bigint | null>;
  /** Simulates the escrow transaction and returns a human readable preview. */
  simulate: (state: WizardState) => Promise<string>;
  /** Signs (Freighter) and submits the escrow transaction. */
  onSubmit: (state: WizardState) => Promise<void>;
  busy: boolean;
  statusMessage: string | null;
  /** Inline balance alert from `useTokenBalance` (e.g. insufficient funds). */
  balanceAlert?: string | null;
  /** Pass `canSubmit` from `useTokenBalance`; false blocks submission. */
  balanceOk?: boolean;
}

const labelCls = "text-xs font-semibold text-muted-foreground uppercase tracking-wider";

export function EscrowWizard(props: EscrowWizardProps) {
  const { walletAddress, tokens, fetchBalance, simulate, onSubmit, busy, statusMessage } = props;
  const { balanceAlert, balanceOk = true } = props;
  const [state, dispatch] = useReducer(wizardReducer, tokens[0]?.address ?? "", initialWizardState);
  const [touched, setTouched] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  // Real-time balance check whenever the wallet or token changes.
  useEffect(() => {
    let cancelled = false;
    if (!walletAddress) return;
    fetchBalance(state.token)
      .then((b) => !cancelled && dispatch({ type: "setBalance", balance: b }))
      .catch(() => !cancelled && dispatch({ type: "setBalance", balance: null }));
    return () => {
      cancelled = true;
    };
  }, [walletAddress, state.token, fetchBalance]);

  const error = touched ? validateStep(state, state.step) : null;
  const set = (field: "token" | "amount" | "beneficiary" | "routingInfo" | "lockDurationDays") =>
    (e: React.ChangeEvent<HTMLInputElement>) => dispatch({ type: "set", field, value: e.target.value });

  const next = () => {
    setTouched(true);
    if (validateStep(state, state.step) === null) {
      setTouched(false);
      dispatch({ type: "next" });
    }
  };

  const runPreview = async () => {
    setPreview("Simulating…");
    try {
      setPreview(await simulate(state));
    } catch (e) {
      setPreview(`Simulation failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="space-y-6" data-testid="escrow-wizard">
      <ol className="grid grid-cols-2 sm:grid-cols-4 gap-2" aria-label="Wizard progress">
        {WIZARD_STEPS.map((name, i) => (
          <li
            key={name}
            aria-current={i === state.step ? "step" : undefined}
            className={`rounded-xl border px-3 py-2 text-xs font-medium ${
              i === state.step
                ? "bg-primary/15 border-primary text-primary"
                : i < state.step
                  ? "border-border text-foreground"
                  : "border-border text-muted-foreground"
            }`}
          >
            {i + 1}. {name}
          </li>
        ))}
      </ol>

      {state.step === 0 && (
        <section className="space-y-4" aria-label={`Step 1: ${WIZARD_STEPS[0]}`}>
          <div className="space-y-2">
            <span id="wiz-token-label" className={labelCls}>Token</span>
            <div role="group" aria-labelledby="wiz-token-label" className="flex flex-wrap gap-2">
              {tokens.map((t) => (
                <button
                  key={t.address}
                  type="button"
                  aria-pressed={state.token === t.address}
                  onClick={() => dispatch({ type: "set", field: "token", value: t.address })}
                  className={`flex-1 min-w-32 py-2 px-3 rounded-xl border text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    state.token === t.address ? "bg-primary/15 border-primary text-primary" : "border-border"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <Input className="font-mono text-xs" value={state.token} onChange={set("token")} aria-label="Token contract" aria-invalid={Boolean(error)} />
          </div>
          <div className="space-y-2">
            <label className={labelCls} htmlFor="wiz-amount">Amount</label>
            <Input id="wiz-amount" type="number" step="0.0000001" value={state.amount} onChange={set("amount")} aria-describedby="wiz-balance-hint" aria-invalid={Boolean(error)} />
            <p id="wiz-balance-hint" className="text-xs text-muted-foreground">
              {state.balance === null
                ? walletAddress ? "Balance unavailable" : "Connect wallet to check balance"
                : `Available: ${Number(state.balance) / 1e7} tokens`}
            </p>
          </div>
        </section>
      )}

      {state.step === 1 && (
        <section className="space-y-4" aria-label={`Step 2: ${WIZARD_STEPS[1]}`}>
          <div className="space-y-2">
            <label className={labelCls} htmlFor="wiz-ben">Target anchor / recipient address</label>
            <Input id="wiz-ben" className="font-mono" placeholder="G..." value={state.beneficiary} onChange={set("beneficiary")} aria-invalid={Boolean(error)} />
          </div>
          <div className="space-y-2">
            <label className={labelCls} htmlFor="wiz-bank">Recipient bank IBAN / routing details</label>
            <Input id="wiz-bank" placeholder="IBAN: DE89370400440532013000" value={state.routingInfo} onChange={set("routingInfo")} aria-describedby="wiz-bank-hint" aria-invalid={Boolean(error)} />
            <p id="wiz-bank-hint" className="text-xs text-muted-foreground">
              Only a SHA-256 <code className="font-mono">profile_hash</code> is stored onchain; raw details never leave your browser.
            </p>
          </div>
        </section>
      )}

      {state.step === 2 && (
        <section className="space-y-4" aria-label={`Step 3: ${WIZARD_STEPS[2]}`}>
          <div className="space-y-2">
            <label className={labelCls} htmlFor="wiz-days">Timeout (days)</label>
            <Input id="wiz-days" type="number" value={state.lockDurationDays} onChange={set("lockDurationDays")} aria-invalid={Boolean(error)} />
          </div>
          <div className="space-y-1">
            <span className={labelCls}>Dispute arbiter</span>
            <p className="text-sm">Protocol admin (resolves disputes onchain)</p>
            <p className="text-xs text-muted-foreground">The contract currently supports a single admin arbiter.</p>
          </div>
        </section>
      )}

      {state.step === LAST_STEP && (
        <section className="space-y-4" aria-label={`Step 4: ${WIZARD_STEPS[LAST_STEP]}`}>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
            {[
              ["Token", state.token],
              ["Amount", state.amount],
              ["Recipient", state.beneficiary],
              ["Bank details", `${state.routingInfo.slice(0, 4)}… (hashed)`],
              ["Timeout", `${state.lockDurationDays} days`],
              ["Arbiter", "Protocol admin"],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl border border-border p-3">
                <dt className="text-muted-foreground uppercase">{k}</dt>
                <dd className="break-all">{v}</dd>
              </div>
            ))}
          </dl>
          <Button type="button" onClick={runPreview} disabled={busy || !walletAddress}>Preview simulation</Button>
          {preview && <p className="text-xs font-mono" role="status">{preview}</p>}
        </section>
      )}

      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      {balanceAlert && !error && <p role="alert" className="text-sm text-red-500">{balanceAlert}</p>}
      {statusMessage && <p role="status" className="text-xs text-muted-foreground">{statusMessage}</p>}

      <div className="flex flex-col-reverse sm:flex-row justify-between gap-3">
        <Button type="button" onClick={() => dispatch({ type: "back" })} disabled={state.step === 0 || busy}>
          Back
        </Button>
        {state.step < LAST_STEP ? (
          <Button type="button" onClick={next}>Next</Button>
        ) : (
          <Button
            type="button"
            onClick={() => onSubmit(state)}
            disabled={busy || !walletAddress || !balanceOk}
          >
            {walletAddress ? "Sign with Freighter" : "Connect wallet to sign"}
          </Button>
        )}
      </div>
    </div>
  );
}
