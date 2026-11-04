"use client";

import React, { useState, useEffect } from "react";
import {
  isConnected,
  requestAccess,
  getAddress,
  getNetworkDetails,
  signTransaction,
} from "@stellar/freighter-api";
import { rpc, xdr } from "@stellar/stellar-sdk";
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
  Scale,
  Coins,
  History,
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
import { hashRoutingInfo } from "@/lib/crypto";
import {
  validateEscrowForm,
  verifyWalletNetwork,
  buildEscrowContractCall,
  buildReleaseContractCall,
  buildRefundContractCall,
  buildResolveDisputeContractCall,
  buildInitialTransaction,
  simulateAndPrepareTransaction,
  submitSignedTransaction,
  pollTransactionConfirmation,
} from "@/lib/transaction";

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
  const [activeTab, setActiveTab] = useState<"create" | "manage">("create");
  const [walletAddress, setWalletAddress] = useState<string>("");
  const [loading, setLoading] = useState(false);

  // Escrow Form State
  const [beneficiary, setBeneficiary] = useState("");
  const [amount, setAmount] = useState("");
  const [tokenAddress, setTokenAddress] = useState(config.nativeSacTokenAddress);
  const [tokenPreset, setTokenPreset] = useState<"xlm" | "usdc" | "custom">("xlm");
  const [routingInfo, setRoutingInfo] = useState("");
  const [lockDurationDays, setLockDurationDays] = useState("7");

  // Escrow Management State
  const [manageEscrowId, setManageEscrowId] = useState("1");
  const [manageAction, setManageAction] = useState<"release" | "refund" | "dispute">("release");
  const [anchorDisbursementAddress, setAnchorDisbursementAddress] = useState("");
  const [payerDisputeBps, setPayerDisputeBps] = useState("5000");

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

  const handleTokenPresetChange = (preset: "xlm" | "usdc" | "custom") => {
    setTokenPreset(preset);
    if (preset === "xlm") {
      setTokenAddress(config.nativeSacTokenAddress);
    } else if (preset === "usdc") {
      // Testnet Circle USDC SAC contract
      setTokenAddress("CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT");
    }
  };

  const executeFreighterTransaction = async (operationBuilder: () => xdr.Operation, description: string) => {
    if (!walletAddress) {
      setTxState("wallet-required");
      setStatusMessage("Freighter wallet connection required to sign transaction.");
      return;
    }

    try {
      try {
        const netDetails = await getNetworkDetails();
        verifyWalletNetwork(netDetails, config.networkPassphrase);
      } catch (netErr: unknown) {
        const msg = netErr instanceof Error ? netErr.message : String(netErr);
        setTxState("failed");
        setStatusMessage(msg);
        return;
      }

      setTxState("simulating");
      setStatusMessage(`Building & simulating ${description} on Testnet...`);

      const server = new rpc.Server(config.rpcUrl);
      const operation = operationBuilder();

      const initialTx = await buildInitialTransaction(
        server,
        walletAddress,
        operation,
        config.networkPassphrase
      );

      const { preparedTx } = await simulateAndPrepareTransaction(server, initialTx);

      setTxState("awaiting-signature");
      setStatusMessage("Awaiting transaction signature in Freighter extension...");

      let signedTxXdr = "";
      try {
        const signResult = await signTransaction(preparedTx.toXDR(), {
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

      if (!signedTxXdr) {
        throw new Error("Freighter did not return a signed transaction envelope");
      }

      setTxState("submitting");
      setStatusMessage("Submitting signed transaction envelope XDR to Stellar RPC...");

      const realTxHash = await submitSignedTransaction(
        server,
        signedTxXdr,
        config.networkPassphrase
      );

      setTxHash(realTxHash);
      setTxState("pending");
      setStatusMessage(
        `Transaction submitted to Testnet mempool! Polling getTransaction (${realTxHash.slice(
          0,
          8
        )}...) for authoritative ledger confirmation...`
      );

      const confirmation = await pollTransactionConfirmation(server, realTxHash);

      setTxState("confirmed");
      setStatusMessage(
        `Action successfully confirmed onchain in ledger ${confirmation.ledger}! Transaction Hash: ${realTxHash.slice(
          0,
          10
        )}...`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTxState("failed");
      setStatusMessage(`Transaction execution failed: ${msg}`);
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
      const validated = validateEscrowForm({
        payer: walletAddress,
        beneficiary,
        token: tokenAddress,
        amount,
        lockDurationDays,
        routingInfo,
      });

      setTxState("preparing");
      setStatusMessage("Hashing sensitive routing information into 32-byte profile_hash commitment...");

      const computedProfileHashHex = await hashRoutingInfo(validated.routingInfo);
      setProfileHashDisplay(computedProfileHashHex);

      await executeFreighterTransaction(
        () => buildEscrowContractCall(config.contractId, validated, computedProfileHashHex),
        `escrow deposit (${amount} tokens)`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTxState("failed");
      setStatusMessage(`Escrow parameter validation error: ${msg}`);
    }
  };

  const handleManageEscrow = async (e: React.FormEvent) => {
    e.preventDefault();

    const escrowIdBigInt = BigInt(manageEscrowId || "0");
    if (escrowIdBigInt <= 0n) {
      setTxState("failed");
      setStatusMessage("Escrow ID must be a positive integer.");
      return;
    }

    if (manageAction === "release") {
      const targetAnchor = anchorDisbursementAddress.trim() || walletAddress;
      await executeFreighterTransaction(
        () =>
          buildReleaseContractCall(
            config.contractId,
            escrowIdBigInt,
            walletAddress,
            targetAnchor
          ),
        `release for escrow #${manageEscrowId} to anchor`
      );
    } else if (manageAction === "refund") {
      await executeFreighterTransaction(
        () => buildRefundContractCall(config.contractId, escrowIdBigInt),
        `refund claim for escrow #${manageEscrowId}`
      );
    } else if (manageAction === "dispute") {
      const payerBps = parseInt(payerDisputeBps, 10) || 5000;
      const beneficiaryBps = 10000 - payerBps;
      await executeFreighterTransaction(
        () =>
          buildResolveDisputeContractCall(
            config.contractId,
            escrowIdBigInt,
            walletAddress,
            payerBps,
            beneficiaryBps
          ),
        `dispute resolution (${payerBps / 100}% payer / ${beneficiaryBps / 100}% beneficiary)`
      );
    }
  };

  const parsedAmount = parseFloat(amount) || 0;
  const protocolFeeEst = (parsedAmount * 0.02).toFixed(2);
  const anchorPayoutEst = (parsedAmount - parseFloat(protocolFeeEst)).toFixed(2);

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
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8 flex-1 w-full">
        {/* Network & Contract Banner */}
        <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-r from-card via-card/90 to-primary/5 p-6 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold tracking-wide bg-primary/10 text-primary border border-primary/20 uppercase font-mono">
                  Stellar Testnet
                </span>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold tracking-wide bg-secondary/20 text-secondary-foreground border border-secondary/40 font-mono">
                  Contract Fee: 200 BPS (2.0%)
                </span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">
                Soroban Anchor Gate & Escrow Bridge
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Authoritative Contract:{" "}
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

        {/* Navigation Tabs */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setActiveTab("create")}
            className={`pb-3 px-6 font-semibold text-sm transition-all border-b-2 flex items-center gap-2 ${
              activeTab === "create"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Lock className="w-4 h-4" />
            <span>Deposit Milestone Escrow</span>
          </button>
          <button
            onClick={() => setActiveTab("manage")}
            className={`pb-3 px-6 font-semibold text-sm transition-all border-b-2 flex items-center gap-2 ${
              activeTab === "manage"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <History className="w-4 h-4" />
            <span>Manage Escrow (Release / Refund / Dispute)</span>
          </button>
        </div>

        {/* Tab Content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {activeTab === "create" ? (
            /* Create Escrow Form */
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

                  {/* Token Preset Selector */}
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                      <Coins className="w-3.5 h-3.5" />
                      Select Token Asset
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleTokenPresetChange("xlm")}
                        className={`flex-1 py-2 px-3 rounded-xl border text-xs font-medium transition ${
                          tokenPreset === "xlm"
                            ? "bg-primary/15 border-primary text-primary font-bold"
                            : "bg-input/40 border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Native SAC (XLM)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTokenPresetChange("usdc")}
                        className={`flex-1 py-2 px-3 rounded-xl border text-xs font-medium transition ${
                          tokenPreset === "usdc"
                            ? "bg-primary/15 border-primary text-primary font-bold"
                            : "bg-input/40 border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        USDC SAC
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTokenPresetChange("custom")}
                        className={`flex-1 py-2 px-3 rounded-xl border text-xs font-medium transition ${
                          tokenPreset === "custom"
                            ? "bg-primary/15 border-primary text-primary font-bold"
                            : "bg-input/40 border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Custom Token (C...)
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Amount (Tokens)
                      </label>
                      <Input
                        type="number"
                        step="0.0000001"
                        placeholder="100.00"
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
                        Est. Protocol Fee (2.0%)
                      </label>
                      <div className="h-11 flex items-center px-4 rounded-xl border border-border bg-muted/40 font-mono text-sm text-muted-foreground">
                        {amount ? `${protocolFeeEst} tokens` : "0.00 tokens"}
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
                      className="font-mono text-xs"
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
                    <span className="text-muted-foreground">Est. Net Anchor Disbursement:</span>
                    <span className="text-primary font-bold">
                      {parsedAmount > 0 ? `${anchorPayoutEst} tokens` : "—"}
                    </span>
                  </div>

                  <Button
                    type="submit"
                    className="w-full h-12 text-base"
                    disabled={
                      txState === "preparing" ||
                      txState === "simulating" ||
                      txState === "awaiting-signature" ||
                      txState === "submitting" ||
                      txState === "pending"
                    }
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
                        <span>Simulating Soroban Transaction...</span>
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
                        <span>Submitting to Testnet RPC...</span>
                      </>
                    )}
                    {txState === "pending" && (
                      <>
                        <Clock className="w-4 h-4 mr-2 animate-spin" />
                        <span>Authoritatively Polling Confirmation...</span>
                      </>
                    )}
                    {(txState === "idle" ||
                      txState === "confirmed" ||
                      txState === "failed" ||
                      txState === "wallet-required") && (
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
                            View Explorer Transaction: {txHash.slice(0, 10)}...{txHash.slice(-6)}
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            /* Manage Escrow Form */
            <Card className="lg:col-span-2">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                    <History className="w-5 h-5" />
                  </div>
                  <div>
                    <CardTitle>Manage Onchain Escrows</CardTitle>
                    <CardDescription>
                      Release funds to anchor partner, claim expiry refunds, or mediate disputes.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleManageEscrow} className="space-y-5">
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Escrow Counter ID
                    </label>
                    <Input
                      type="number"
                      placeholder="1"
                      value={manageEscrowId}
                      onChange={(e) => setManageEscrowId(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Target Action
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        onClick={() => setManageAction("release")}
                        className={`py-3 px-3 rounded-xl border text-xs font-medium transition ${
                          manageAction === "release"
                            ? "bg-primary/15 border-primary text-primary font-bold"
                            : "bg-input/40 border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Release to Anchor
                      </button>
                      <button
                        type="button"
                        onClick={() => setManageAction("refund")}
                        className={`py-3 px-3 rounded-xl border text-xs font-medium transition ${
                          manageAction === "refund"
                            ? "bg-primary/15 border-primary text-primary font-bold"
                            : "bg-input/40 border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Claim Refund
                      </button>
                      <button
                        type="button"
                        onClick={() => setManageAction("dispute")}
                        className={`py-3 px-3 rounded-xl border text-xs font-medium transition ${
                          manageAction === "dispute"
                            ? "bg-primary/15 border-primary text-primary font-bold"
                            : "bg-input/40 border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Arbiter Dispute
                      </button>
                    </div>
                  </div>

                  {manageAction === "release" && (
                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Anchor Disbursement Payout Address
                      </label>
                      <Input
                        type="text"
                        placeholder="G... (Leave empty to use connected wallet)"
                        value={anchorDisbursementAddress}
                        onChange={(e) => setAnchorDisbursementAddress(e.target.value)}
                        className="font-mono text-xs"
                      />
                      <p className="text-xs text-muted-foreground">
                        Authorizes release of escrowed funds. The contract deducts protocol fee (2.0%) and disburses net tokens to this anchor address, emitting a cryptographic event for the relay daemon.
                      </p>
                    </div>
                  )}

                  {manageAction === "refund" && (
                    <div className="p-4 rounded-xl border border-border bg-input/40 text-xs space-y-2 text-muted-foreground">
                      <span className="font-bold text-foreground block uppercase">Refund Conditions:</span>
                      <p>
                        Refunds can only be claimed by the original payer wallet after the lock duration timestamp has elapsed. Escrow state will transition from <span className="text-primary font-mono">FUNDED</span> to <span className="text-primary font-mono">REFUNDED</span>.
                      </p>
                    </div>
                  )}

                  {manageAction === "dispute" && (
                    <div className="space-y-4 p-4 rounded-xl border border-border bg-input/40 text-xs">
                      <span className="font-bold text-foreground block uppercase flex items-center gap-1.5">
                        <Scale className="w-4 h-4 text-primary" />
                        Dispute Settlement Split (Arbiter Role)
                      </span>
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs">
                          <span>Payer Share: {parseInt(payerDisputeBps, 10) / 100}%</span>
                          <span>Beneficiary Share: {(10000 - parseInt(payerDisputeBps, 10)) / 100}%</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="10000"
                          step="500"
                          value={payerDisputeBps}
                          onChange={(e) => setPayerDisputeBps(e.target.value)}
                          className="w-full accent-primary"
                        />
                      </div>
                      <p className="text-muted-foreground">
                        Settles contested escrow by distributing funds mathematically between payer and beneficiary in a single atomic transaction.
                      </p>
                    </div>
                  )}

                  <Button
                    type="submit"
                    className="w-full h-12 text-base"
                    disabled={
                      txState === "simulating" ||
                      txState === "awaiting-signature" ||
                      txState === "submitting" ||
                      txState === "pending"
                    }
                  >
                    {manageAction === "release" && "Execute Anchor Release"}
                    {manageAction === "refund" && "Claim Expired Refund"}
                    {manageAction === "dispute" && "Execute Dispute Settlement"}
                  </Button>
                </form>

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
                            View Explorer Transaction: {txHash.slice(0, 10)}...{txHash.slice(-6)}
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

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
                    Funded → Disbursed → Refunded / Disputed
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
          <span>SorobanAnchor Gate — Non-Custodial Milestone Escrow & Anchor Bridge</span>
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
