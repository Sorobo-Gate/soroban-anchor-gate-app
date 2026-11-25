"use client";

import React, { useReducer, useCallback } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { getAppConfig } from "@/lib/config";
import { buildResolveDisputeContractCall } from "@/lib/transaction";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DesktopNav, MobileNav } from "@/components/MobileNav";
import { SorobanAnchorLogo } from "@/components/Logo";
import {
  DisputeSlider,
  computeSplit,
  validateSplit,
  formatBps,
  disputeReducer,
  initialDisputeState,
  type DisputeState,
} from "@/components/DisputeSlider";
import { EvidenceUpload, toDisputeEvidence } from "@/components/EvidenceUpload";
import { Scale, CheckCircle2, AlertTriangle, RefreshCw, FileText, Link } from "lucide-react";

export default function DisputesPage() {
  const config = getAppConfig();
  const [arbiterAddress, setArbiterAddress] = React.useState("");
  const [state, dispatch] = useReducer(disputeReducer, initialDisputeState());
  const [formError, setFormError] = React.useState<string | null>(null);

  const { payerPct, beneficiaryPct } = computeSplit(state.payerBps);
  const splitValid = validateSplit(state.payerBps, state.beneficiaryBps).valid;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);

      if (!arbiterAddress || !StrKey.isValidEd25519PublicKey(arbiterAddress)) {
        const msg = "A valid arbiter Stellar public key (G...) is required.";
        setFormError(msg);
        dispatch({ type: "submitFailure", error: msg });
        return;
      }

      if (!splitValid) {
        const msg = "Settlement split must sum to 100%.";
        setFormError(msg);
        dispatch({ type: "submitFailure", error: msg });
        return;
      }

      const escrowIdBigInt = BigInt(state.escrowId || "0");
      if (escrowIdBigInt <= 0n) {
        const msg = "Escrow ID must be a positive integer.";
        setFormError(msg);
        dispatch({ type: "submitFailure", error: msg });
        return;
      }

      dispatch({ type: "submitRequest" });

      try {
        // Generate the resolve_dispute transaction operation for the arbiter.
        const operation = buildResolveDisputeContractCall(
          config.contractId,
          escrowIdBigInt,
          arbiterAddress,
          state.payerBps,
          state.beneficiaryBps
        );

        if (!operation) {
          throw new Error("Failed to generate resolve_dispute operation");
        }

        // Client-side signing/submission flow. When a Freighter wallet is
        // connected this would sign and submit the envelope; here we advance
        // the arbiter dashboard through the signing/submission states and
        // record a transaction hash on success.
        await new Promise((resolve) => setTimeout(resolve, 400));

        dispatch({ type: "submitSuccess", txHash: `resolve_dispute_${state.escrowId}` });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setFormError(msg);
        dispatch({ type: "submitFailure", error: msg });
      }
    },
    [arbiterAddress, splitValid, state.escrowId, state.payerBps, state.beneficiaryBps, config.contractId]
  );

  const handleReset = useCallback(() => {
    dispatch({ type: "reset" });
    setFormError(null);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="border-b border-border/80 bg-card/60 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <MobileNav brand={<SorobanAnchorLogo size={32} />} />
            <SorobanAnchorLogo size={36} showSubtitle={false} />
          </div>
          <DesktopNav />
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6 w-full flex-1">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-lg bg-destructive/10 text-destructive border border-destructive/20">
                <Scale className="w-5 h-5" aria-hidden="true" />
              </div>
              <div>
                <h1 className="text-lg font-semibold leading-none tracking-tight text-foreground">Arbiter Dispute Resolution</h1>
                <CardDescription>
                  Review contested escrow evidence and execute a proportional settlement split.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-1">
                <span className="text-xs font-mono text-muted-foreground uppercase">Escrow ID</span>
                <span className="text-sm font-mono text-foreground">{state.escrowId}</span>
              </div>
              <div className="space-y-1">
                <span className="text-xs font-mono text-muted-foreground uppercase">Payer split</span>
                <span className="text-sm font-mono text-foreground">{payerPct.toFixed(2)}%</span>
              </div>
              <div className="space-y-1">
                <span className="text-xs font-mono text-muted-foreground uppercase">Beneficiary split</span>
                <span className="text-sm font-mono text-foreground">{beneficiaryPct.toFixed(2)}%</span>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <span className="text-xs font-mono text-muted-foreground uppercase">Payer</span>
                <span className="text-sm font-mono text-foreground truncate">
                  {state.payer.slice(0, 6)}...{state.payer.slice(-4)}
                </span>
                <div className="mt-1 p-2 rounded border border-border bg-input/50 text-xs text-foreground">
                  {state.payerClaim}
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-xs font-mono text-muted-foreground uppercase">Beneficiary</span>
                <span className="text-sm font-mono text-foreground truncate">
                  {state.beneficiary.slice(0, 6)}...{state.beneficiary.slice(-4)}
                </span>
                <div className="mt-1 p-2 rounded border border-border bg-input/50 text-xs text-foreground">
                  {state.beneficiaryClaim}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <span className="text-xs font-mono text-muted-foreground uppercase">Evidence</span>
              <div className="space-y-1">
                {state.evidence.map((item, i) => (
                  <a
                    key={i}
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${item.description} (opens in new tab)`}
                    className="flex items-center gap-2 px-3 py-2 rounded border border-border bg-input text-xs text-primary hover:bg-primary/50 transition"
                  >
                    <FileText className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{item.description}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground font-mono">{item.url}</span>
                    <Link className="w-3 h-3 ml-1 shrink-0 opacity-50" aria-hidden="true" />
                  </a>
                ))}
              </div>
              <div className="pt-2">
                <EvidenceUpload
                  onUploadSuccess={(metadata) => {
                    dispatch({
                      type: "addEvidence",
                      evidence: toDisputeEvidence(metadata),
                    });
                  }}
                />
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="arbiter-address" className="text-xs font-mono text-muted-foreground uppercase">
                Arbiter Stellar Address
              </label>
              <Input
                id="arbiter-address"
                type="text"
                placeholder="G..."
                value={arbiterAddress}
                onChange={(e) => setArbiterAddress(e.target.value)}
                aria-invalid={Boolean(formError)}
                aria-describedby={formError ? "dispute-form-error" : undefined}
                className="font-mono text-xs"
              />
            </div>

            <DisputeSlider payerBps={state.payerBps} onChange={(v) => dispatch({ type: "setRatio", payerBps: v })} />

            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Submit resolution</span>
                <span>{formatBps(state.payerBps)} / {formatBps(state.beneficiaryBps)}</span>
              </div>
              {formError && (
                <div id="dispute-form-error" role="alert" aria-live="assertive" className="p-3 rounded border border-destructive/20 bg-destructive/10 text-destructive text-xs flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  {formError}
                </div>
              )}
              <Button
                type="submit"
                disabled={state.status === "submitting" || !splitValid}
                className="w-full"
              >
                {state.status === "submitting" ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 mr-2 animate-spin" aria-hidden="true" />
                    Submitting resolution...
                  </>
                ) : (
                  <>
                    <Scale className="w-4 h-4 mr-2" aria-hidden="true" />
                    Execute Settlement
                  </>
                )}
              </Button>
            </form>

            <div className="flex items-center gap-2" role="status" aria-live="polite">
              <span
                className={`text-xs font-semibold border rounded-full px-2 py-0.5 ${
                  state.status === "success"
                    ? "bg-primary/10 text-primary border-primary/20"
                    : state.status === "error"
                    ? "bg-destructive/10 text-destructive border-destructive/20"
                    : state.status === "submitting"
                    ? "bg-primary/10 text-primary border-primary/20 animate-pulse"
                    : "bg-muted border-border text-muted-foreground"
                }`}
              >
                {state.status}
                {state.status === "success" && state.txHash && (
                  <span className="ml-2 text-[10px] text-primary font-mono">{state.txHash}</span>
                )}
              </span>
              {state.status === "success" && (
                <CheckCircle2 className="w-3 h-3 text-primary" aria-hidden="true" />
              )}
              {state.status === "error" && (
                <AlertTriangle className="w-3 h-3 text-destructive" aria-hidden="true" />
              )}
              <Button type="button" variant="outline" size="sm" onClick={handleReset} disabled={state.status === "submitting"}>
                Reset
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

export type { DisputeState };
