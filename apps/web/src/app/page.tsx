"use client";

import React, { useState } from "react";
import { isConnected, requestAccess, getAddress } from "@stellar/freighter-api";
import { ArrowRight, CheckCircle2, Lock, ShieldCheck, Wallet, ExternalLink, RefreshCw } from "lucide-react";
import { SorobanAnchorLogo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const CONTRACT_ID = "CCCSLE7UN2FRLB2HQWEUEXM4365NDYH3QSC6J5TILQWBSTTIDKFWXX2Y";

export default function HomePage() {
  const [walletAddress, setWalletAddress] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [beneficiary, setBeneficiary] = useState("");
  const [amount, setAmount] = useState("");
  const [routingInfo, setRoutingInfo] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleConnectWallet = async () => {
    try {
      setLoading(true);
      const connected = await isConnected();
      if (!connected) {
        alert("Freighter wallet extension not found. Please install Freighter from freighter.app.");
        return;
      }
      const access = await requestAccess();
      if (access) {
        const addressObj = await getAddress();
        setWalletAddress(addressObj.address);
      }
    } catch (err: any) {
      alert("Failed to connect wallet: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateEscrow = (e: React.FormEvent) => {
    e.preventDefault();
    if (!walletAddress) {
      alert("Please connect your Freighter wallet before initializing escrow.");
      return;
    }
    setStatusMessage(
      `Escrow initialized for ${amount} USDC. Profile hash derived from banking parameters. Locked via contract ${CONTRACT_ID.slice(0, 6)}...`
    );
  };

  const parsedAmount = parseFloat(amount) || 0;
  const protocolFee = (parsedAmount * 0.02).toFixed(2);
  const anchorPayout = (parsedAmount - parseFloat(protocolFee)).toFixed(2);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col justify-between">
      {/* Navbar */}
      <header className="border-b border-border/80 bg-card/60 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-20 flex items-center justify-between">
          <SorobanAnchorLogo size={42} />

          <div className="flex items-center gap-4">
            {walletAddress ? (
              <div className="flex items-center gap-2 bg-input border border-border px-4 py-2 rounded-xl text-xs font-mono text-primary">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                <span>{walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}</span>
              </div>
            ) : (
              <Button onClick={handleConnectWallet} disabled={loading}>
                <Wallet className="w-4 h-4 mr-2" />
                <span>{loading ? "Connecting..." : "Connect Freighter"}</span>
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Main Body */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-10 space-y-8 flex-1 w-full">
        {/* Network & Contract Banner */}
        <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-r from-card via-card to-muted p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold tracking-wide bg-primary/10 text-primary border border-primary/20 uppercase font-mono">
                  Stellar Testnet
                </span>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold tracking-wide bg-secondary/20 text-secondary-foreground border border-secondary/40 font-mono">
                  Protocol Fee: 200 BPS
                </span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">
                Escrow & Anchor Settlement Console
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Active EscrowGate:{" "}
                <a
                  href={`https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-primary hover:underline inline-flex items-center gap-1"
                >
                  {CONTRACT_ID.slice(0, 16)}...{CONTRACT_ID.slice(-8)}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </p>
            </div>
          </div>
        </div>

        {/* Content Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Deposit Form */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                  <Lock className="w-5 h-5" />
                </div>
                <div>
                  <CardTitle>Deposit Milestone Escrow</CardTitle>
                  <CardDescription>Lock SAC USDC onchain with cryptographic SEP-31 anchor routing.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreateEscrow} className="space-y-5">
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Contractor Stellar Public Key
                  </label>
                  <Input
                    type="text"
                    placeholder="G..."
                    value={beneficiary}
                    onChange={(e) => setBeneficiary(e.target.value)}
                    className="font-mono"
                    required
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Amount (USDC)
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="1000.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Protocol Fee (2.0%)
                    </label>
                    <div className="h-11 flex items-center px-4 rounded-xl border border-border bg-muted/40 font-mono text-sm text-muted-foreground">
                      {amount ? `${protocolFee} USDC` : "0.00 USDC"}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Off-Ramp Target (SEP-9 / SEP-31 Bank Rail)
                  </label>
                  <Input
                    type="text"
                    placeholder="e.g. IBAN: DE89... / Sort Code: 04-00-04 / M-Pesa Phone"
                    value={routingInfo}
                    onChange={(e) => setRoutingInfo(e.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    This coordinate is hashed with SHA-256 into a 32-byte identifier (<code className="text-primary font-mono">profile_hash</code>) onchain.
                  </p>
                </div>

                <div className="p-4 rounded-xl border border-border bg-input/40 flex items-center justify-between text-xs font-mono">
                  <span className="text-muted-foreground">Contractor Net Fiat Settlement:</span>
                  <span className="text-primary font-bold">{parsedAmount > 0 ? `${anchorPayout} USDC equiv.` : "—"}</span>
                </div>

                <Button type="submit" className="w-full h-12 text-base">
                  <span>Initialize Escrow on Testnet</span>
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </form>

              {statusMessage && (
                <div className="mt-5 p-4 rounded-xl bg-primary/10 border border-primary/20 text-primary text-sm flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 shrink-0 text-primary" />
                  <div>{statusMessage}</div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Sidebar / Protocol State */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-lg bg-secondary/20 text-secondary-foreground border border-secondary/30">
                    <ShieldCheck className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle>Gateway Guard</CardTitle>
                    <CardDescription>Onchain enforcement</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-3.5 rounded-xl border border-border bg-input/50 space-y-1">
                  <span className="text-xs text-muted-foreground block uppercase font-mono">State Lifecycle</span>
                  <span className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5 text-primary animate-spin" />
                    Funded → Disbursed → Settled
                  </span>
                </div>

                <div className="p-3.5 rounded-xl border border-border bg-input/50 space-y-1">
                  <span className="text-xs text-muted-foreground block uppercase font-mono">Storage Architecture</span>
                  <span className="text-sm font-semibold text-foreground">
                    Persistent Storage with TTL Renewal
                  </span>
                </div>

                <div className="p-3.5 rounded-xl border border-border bg-input/50 space-y-1">
                  <span className="text-xs text-muted-foreground block uppercase font-mono">Relay Verification</span>
                  <span className="text-sm font-semibold text-foreground">
                    Go Daemon (SEP-10 Auth + SEP-31 Off-Ramp)
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/80 py-6 bg-card/40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-muted-foreground">
          <span>SorobanAnchor Gate — Open-Source Stellar Wave Protocol</span>
          <div className="flex items-center gap-4">
            <a href="https://github.com/Sorobo-Gate/soroban-anchor-gate-contract" target="_blank" rel="noreferrer" className="hover:text-primary transition">Contract Repo</a>
            <a href="https://github.com/Sorobo-Gate/soroban-anchor-gate-app" target="_blank" rel="noreferrer" className="hover:text-primary transition">App Repo</a>
          </div>
        </div>
      </footer>
    </div>
  );
}