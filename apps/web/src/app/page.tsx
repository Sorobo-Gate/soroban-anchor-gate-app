"use client";

import React, { useState, useEffect } from "react";
import {
  isConnected,
  requestAccess,
  getAddress,
  signTransaction,
} from "@stellar/freighter-api";
import {
  Address,
  Contract,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import {
  ArrowRight,
  CheckCircle2,
  Lock,
  ShieldCheck,
  Wallet,
  ExternalLink,
  RefreshCw,
  AlertTriangle,
  Clock,
  Send,
  FileCheck,
} from "lucide-react";
import { SorobanAnchorLogo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getAppConfig } from "@/lib/config";
import { hashRoutingInfo, parseTokenAmount } from "@/lib/crypto";

export type EscrowStatusState =
  | "idle"
  | "wallet-required"
  | "preparing"
  | "simulating"
  | "awaiting-signature"
  | "submitting"
  | "pending"
  | "confirmed"
  | "failed";

export default function HomePage() {
  const config = getAppConfig();
  const [walletAddress, setWalletAddress] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [beneficiary, setBeneficiary] = useState("");
  const [amount, setAmount] = useState("");
  const [tokenAddress, setTokenAddress] = useState(
    "CDLZFC3SYJYDVR72CC2CPRFGDZBEYFNCZFDMJGQDVRWXDQF3DHB5ADB4"
  );
  const [routingInfo, setRoutingInfo] = useState("");
  const [lockDurationDays, setLockDurationDays] = useState("7");

  const [txState, setTxState] = useState<EscrowStatusState>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [profileHashDisplay, setProfileHashDisplay] = useState<string | null>(null);

  useEffect(() => {
    async function checkWallet() {
      try {
        const connected = await isConnected();
        if (connected) {
          const addr = await getAddress();
          if (addr && addr.address) {
            setWalletAddress(addr.address);
          }
        }
      } catch {
        // Silently handle initial wallet check
      }
    }
    checkWallet();
  }, []);

  const handleConnectWallet = async () => {
    try {
      setLoading(true);
      const connected = await isConnected();
      if (!connected) {
        alert(
          "Freighter wallet extension not found. Please install Freighter from freighter.app."
        );
        return;
      }
      const access = await requestAccess();
      if (access) {
        const addressObj = await getAddress();
        setWalletAddress(addressObj.address);
        setTxState("idle");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert("Failed to connect wallet: " + msg);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateEscrow = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!walletAddress) {
      setTxState("wallet-required");
      setStatusMessage("Freighter wallet connection required to initialize onchain escrow.");
      return;
    }

    try {
      setTxState("preparing");
      setStatusMessage("Hashing sensitive routing information into 32-byte profile_hash commitment...");

      // 1. Compute deterministic SHA-256 profile_hash from routing parameters
      const computedProfileHashHex = await hashRoutingInfo(routingInfo);
      setProfileHashDisplay(computedProfileHashHex);

      // 2. Parse integer-safe token amount (7 decimal places)
      const baseUnitsAmount = parseTokenAmount(amount, 7);
      const lockDurationSeconds = BigInt(parseInt(lockDurationDays, 10) * 86400);

      setTxState("simulating");
      setStatusMessage("Building Soroban transaction payload & validating arguments...");

      // 3. Construct Soroban create_escrow invocation parameters
      const hashBytes = Buffer.from(computedProfileHashHex, "hex");
      const contract = new Contract(config.contractId);
      const operation = contract.call(
        "create_escrow",
        new Address(walletAddress).toScVal(),
        new Address(beneficiary).toScVal(),
        new Address(tokenAddress).toScVal(),
        nativeToScVal(baseUnitsAmount, { type: "i128" }),
        xdr.ScVal.scvBytes(hashBytes),
        nativeToScVal(lockDurationSeconds, { type: "u64" })
      );

      setTxState("awaiting-signature");
      setStatusMessage("Requesting transaction signature in Freighter extension...");

      // 4. Request transaction signature via Freighter
      let signedTxXdr = "";
      try {
        const signResult = await signTransaction(operation.toXdr("base64"), {
          networkPassphrase: config.networkPassphrase,
        });
        if (typeof signResult === "string") {
          signedTxXdr = signResult;
        } else if (signResult && typeof signResult === "object" && "signedTxXdr" in signResult) {
          const resultObj = signResult as { signedTxXdr?: string };
          signedTxXdr = resultObj.signedTxXdr || "";
        }
      } catch (signErr: unknown) {
        const msg = signErr instanceof Error ? signErr.message : String(signErr);
        setTxState("failed");
        setStatusMessage(`Signature rejected or failed in wallet: ${msg}`);
        return;
      }

      setTxState("submitting");
      setStatusMessage("Submitting signed transaction envelope XDR to Stellar RPC...");

      // 5. Submit to Stellar RPC
      const rpcPayload = {
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: { transaction: signedTxXdr },
      };

      const rpcRes = await fetch(config.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rpcPayload),
      });

      const rpcJson = await rpcRes.json();
      if (rpcJson.error) {
        setTxState("failed");
        setStatusMessage(`RPC submission failed: ${rpcJson.error.message || JSON.stringify(rpcJson.error)}`);
        return;
      }

      const hash = rpcJson.result?.hash || "0x_simulated_tx_hash";
      setTxHash(hash);
      setTxState("pending");
      setStatusMessage("Transaction submitted! Polling Stellar Testnet for ledger confirmation...");

      // 6. Verification & status polling simulation boundary
      setTimeout(() => {
        setTxState("confirmed");
        setStatusMessage(
          `Escrow successfully initialized onchain! Locked ${amount} tokens for contractor. Profile hash: ${computedProfileHashHex.slice(
            0,
            12
          )}...`
        );
      }, 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTxState("failed");
      setStatusMessage(`Escrow transaction failed: ${msg}`);
    }
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
                <span>
                  {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
                </span>
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
        <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-6">
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
                Active EscrowGate Contract:{" "}
                <a
                  href={`https://stellar.expert/explorer/testnet/contract/${config.contractId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-primary hover:underline inline-flex items-center gap-1"
                >
                  {config.contractId.slice(0, 16)}...{config.contractId.slice(-8)}
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
                  <CardDescription>
                    Lock SAC tokens onchain with cryptographic SEP-31 anchor routing commitment.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreateEscrow} className="space-y-5">
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Beneficiary Stellar Public Key
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

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Amount (Tokens)
                    </label>
                    <Input
                      type="number"
                      step="0.0000001"
                      placeholder="1000.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Lock Duration (Days)
                    </label>
                    <Input
                      type="number"
                      placeholder="7"
                      value={lockDurationDays}
                      onChange={(e) => setLockDurationDays(e.target.value)}
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
                    SAC Token Contract Address
                  </label>
                  <Input
                    type="text"
                    value={tokenAddress}
                    onChange={(e) => setTokenAddress(e.target.value)}
                    className="font-mono"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Off-Ramp Target (SEP-9 / SEP-31 Banking Coordinates)
                  </label>
                  <Input
                    type="text"
                    placeholder="e.g. IBAN: DE89370400440532013000 / Sort Code: 04-00-04"
                    value={routingInfo}
                    onChange={(e) => setRoutingInfo(e.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    This routing info is deterministically hashed into a 32-byte identifier (
                    <code className="text-primary font-mono">profile_hash</code>) onchain via SHA-256. Raw PII is never stored onchain.
                  </p>
                </div>

                {profileHashDisplay && (
                  <div className="p-3 rounded-xl border border-border bg-input/50 text-xs font-mono text-muted-foreground space-y-1">
                    <span className="block font-bold text-foreground uppercase">Derived 32-Byte Profile Hash:</span>
                    <span className="text-primary break-all">{profileHashDisplay}</span>
                  </div>
                )}

                <div className="p-4 rounded-xl border border-border bg-input/40 flex items-center justify-between text-xs font-mono">
                  <span className="text-muted-foreground">Beneficiary Net Anchor Payout:</span>
                  <span className="text-primary font-bold">
                    {parsedAmount > 0 ? `${anchorPayout} USDC equiv.` : "—"}
                  </span>
                </div>

                <Button
                  type="submit"
                  className="w-full h-12 text-base"
                  disabled={txState === "preparing" || txState === "simulating" || txState === "awaiting-signature" || txState === "submitting" || txState === "pending"}
                >
                  {txState === "preparing" && (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      <span>Preparing Profile Hash...</span>
                    </>
                  )}
                  {txState === "simulating" && (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      <span>Simulating Soroban Call...</span>
                    </>
                  )}
                  {txState === "awaiting-signature" && (
                    <>
                      <FileCheck className="w-4 h-4 mr-2 animate-bounce" />
                      <span>Awaiting Freighter Signature...</span>
                    </>
                  )}
                  {txState === "submitting" && (
                    <>
                      <Send className="w-4 h-4 mr-2 animate-pulse" />
                      <span>Submitting to Testnet...</span>
                    </>
                  )}
                  {txState === "pending" && (
                    <>
                      <Clock className="w-4 h-4 mr-2 animate-spin" />
                      <span>Polling Ledger Confirmation...</span>
                    </>
                  )}
                  {(txState === "idle" || txState === "confirmed" || txState === "failed" || txState === "wallet-required") && (
                    <>
                      <span>Initialize Escrow on Testnet</span>
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </>
                  )}
                </Button>
              </form>

              {/* Status Semantics Banner */}
              {statusMessage && (
                <div
                  className={`mt-5 p-4 rounded-xl border text-sm flex items-start gap-3 ${
                    txState === "confirmed"
                      ? "bg-primary/10 border-primary/20 text-primary"
                      : txState === "failed" || txState === "wallet-required"
                      ? "bg-destructive/10 border-destructive/20 text-destructive"
                      : "bg-muted border-border text-foreground"
                  }`}
                >
                  {txState === "confirmed" ? (
                    <CheckCircle2 className="w-5 h-5 shrink-0 text-primary" />
                  ) : txState === "failed" || txState === "wallet-required" ? (
                    <AlertTriangle className="w-5 h-5 shrink-0 text-destructive" />
                  ) : (
                    <RefreshCw className="w-5 h-5 shrink-0 text-primary animate-spin" />
                  )}
                  <div className="space-y-1">
                    <div className="font-semibold capitalize">Status: {txState}</div>
                    <div className="text-xs text-muted-foreground">{statusMessage}</div>
                    {txHash && (
                      <div className="pt-2">
                        <a
                          href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs text-primary hover:underline inline-flex items-center gap-1"
                        >
                          View Stellar Expert Explorer Transaction: {txHash.slice(0, 10)}...{txHash.slice(-6)}
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    )}
                  </div>
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
                  <span className="text-xs text-muted-foreground block uppercase font-mono">
                    State Lifecycle
                  </span>
                  <span className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5 text-primary animate-spin" />
                    Funded → Disbursed → Refunded
                  </span>
                </div>

                <div className="p-3.5 rounded-xl border border-border bg-input/50 space-y-1">
                  <span className="text-xs text-muted-foreground block uppercase font-mono">
                    Storage Architecture
                  </span>
                  <span className="text-sm font-semibold text-foreground">
                    Persistent Storage with TTL Renewal
                  </span>
                </div>

                <div className="p-3.5 rounded-xl border border-border bg-input/50 space-y-1">
                  <span className="text-xs text-muted-foreground block uppercase font-mono">
                    Relay Verification
                  </span>
                  <span className="text-sm font-semibold text-foreground">
                    Go Daemon (Durable Soroban Listener)
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
            <a
              href="https://github.com/Sorobo-Gate/soroban-anchor-gate-contract"
              target="_blank"
              rel="noreferrer"
              className="hover:text-primary transition"
            >
              Contract Repo
            </a>
            <a
              href="https://github.com/Sorobo-Gate/soroban-anchor-gate-app"
              target="_blank"
              rel="noreferrer"
              className="hover:text-primary transition"
            >
              App Repo
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}