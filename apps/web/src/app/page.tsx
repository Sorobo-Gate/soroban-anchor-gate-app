"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
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
  Table,
} from "lucide-react";
import { SorobanAnchorLogo } from "@/components/Logo";
import { EscrowTable } from "@/components/EscrowTable";
import type { EscrowRow } from "@/components/EscrowTable";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DesktopNav, MobileNav } from "@/components/MobileNav";
import { PaymentQR } from "@/components/PaymentQR";
import { handleHorizontalButtonKeyDown } from "@/lib/a11y";
import {
  SimulationModal,
  runPreflightSimulation,
  type SimulationModalState,
} from "@/components/SimulationModal";
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

const SAMPLE_ESCROWS: EscrowRow[] = [
  {
    id: "E-001",
    recipient: "GAAAAA1111111111111111111111111111111111111111111111111111",
    token: "XLM",
    amount: 1000,
    status: "Funded",
    createdAt: "2026-01-10T10:00:00Z",
  },
  {
    id: "E-002",
    recipient: "GBBBBB2222222222222222222222222222222222222222222222222222",
    token: "USDC",
    amount: 500,
    status: "Disbursed",
    createdAt: "2026-01-15T12:00:00Z",
  },
  {
    id: "E-003",
    recipient: "GCCCCC3333333333333333333333333333333333333333333333333333",
    token: "XLM",
    amount: 2000,
    status: "Disputed",
    createdAt: "2026-02-01T09:00:00Z",
  },
  {
    id: "E-004",
    recipient: "GDDDDD4444444444444444444444444444444444444444444444444444",
    token: "USDC",
    amount: 750,
    status: "Refunded",
    createdAt: "2026-02-05T14:00:00Z",
  },
  {
    id: "E-005",
    recipient: "GEEEEE5555555555555555555555555555555555555555555555555555",
    token: "XLM",
    amount: 1500,
    status: "Funded",
    createdAt: "2026-03-01T08:00:00Z",
  },
];

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

  // Pre-flight simulation modal: signing only proceeds after explicit user approval.
  const [preflight, setPreflight] = useState<{
    state: SimulationModalState;
    actionLabel: string;
    funding?: { amount: string; memoHashHex: string; assetCode: string; xdr: string };
  } | null>(null);
  const preflightDecision = useRef<((approved: boolean) => void) | null>(null);

  const resolvePreflight = useCallback((approved: boolean) => {
    preflightDecision.current?.(approved);
    preflightDecision.current = null;
    setPreflight(null);
  }, []);
  const handlePreflightConfirm = useCallback(() => resolvePreflight(true), [resolvePreflight]);
  const handlePreflightCancel = useCallback(() => resolvePreflight(false), [resolvePreflight]);

  const awaitPreflightDecision = () =>
    new Promise<boolean>((resolve) => {
      preflightDecision.current = resolve;
    });

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

  const executeFreighterTransaction = async (
    operationBuilder: () => xdr.Operation,
    description: string,
    funding?: { amount: string; memoHashHex: string; assetCode: string }
  ) => {
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

      // Pre-flight: simulate BEFORE any wallet popup and let the user review costs / reverts.
      setPreflight({ state: { phase: "simulating" }, actionLabel: description });
      const preflightResult = await runPreflightSimulation(server, initialTx);

      if (!preflightResult.ok) {
        setPreflight({ state: { phase: "reverted", error: preflightResult.error }, actionLabel: description });
        setTxState("failed");
        setStatusMessage(`Simulation reverted: ${preflightResult.error.title}. ${preflightResult.error.explanation}`);
        await awaitPreflightDecision();
        return;
      }

      const { preparedTx } = preflightResult;
      setPreflight({
        state: { phase: "ready", summary: preflightResult.summary },
        actionLabel: description,
        funding: funding ? { ...funding, xdr: preparedTx.toXDR() } : undefined,
      });
      const approved = await awaitPreflightDecision();
      if (!approved) {
        setTxState("idle");
        setStatusMessage("Transaction cancelled after pre-flight review. Nothing was signed.");
        return;
      }

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
      preflightDecision.current = null;
      setPreflight(null);
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
        `escrow deposit (${amount} tokens)`,
        {
          amount,
          memoHashHex: computedProfileHashHex,
          assetCode: tokenPreset === "usdc" ? "USDC" : tokenPreset === "xlm" ? "XLM" : "TOKEN",
        }
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
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-20 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <MobileNav brand={<SorobanAnchorLogo size={32} />} />
            <SorobanAnchorLogo size={42} />
          </div>

          <DesktopNav />

          <div className="flex items-center gap-4">
            {walletAddress ? (
              <div
                aria-label={`Connected wallet ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`}
                className="flex items-center gap-2 bg-input border border-border px-4 py-2 rounded-xl text-xs font-mono text-primary"
              >
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" aria-hidden="true" />
                <span>
                  {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
                </span>
              </div>
            ) : (
              <Button type="button" onClick={handleConnectWallet} disabled={loading}>
                <Wallet className="w-4 h-4 mr-2" aria-hidden="true" />
                <span>{loading ? "Connecting..." : "Connect Freighter"}</span>
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Main Body */}
      <main id="main-content" tabIndex={-1} className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8 flex-1 w-full">
        {/* Network & Contract Banner */}
        <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-r from-card via-card/95 to-accent/30 p-6 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 relative z-10">
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold tracking-wide bg-primary/10 text-brand-gate border border-primary/20 uppercase font-mono">
                  Stellar Testnet
                </span>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold tracking-wide bg-secondary text-secondary-foreground border border-border font-mono">
                  Contract Fee: 200 BPS (2.0%)
                </span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
                Soroban Anchor Gate & Escrow Bridge
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Create &bull; Manage &bull; Track &bull; Settle Escrows on Stellar
              </p>
              <p className="text-xs text-muted-foreground/80 mt-2">
                Authoritative Contract:{" "}
                <a
                  href={`https://stellar.expert/explorer/testnet/contract/${config.contractId}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`View authoritative contract ${config.contractId.slice(0, 16)}...${config.contractId.slice(-8)} on Stellar Expert (opens in new tab)`}
                  className="font-mono text-brand-gate hover:underline inline-flex items-center gap-1"
                >
                  {config.contractId.slice(0, 16)}...{config.contractId.slice(-8)}
                  <ExternalLink className="w-3 h-3" aria-hidden="true" />
                </a>
              </p>
            </div>

            <div className="hidden lg:flex items-center gap-6 text-xs text-muted-foreground border-l border-border/60 pl-6">
              <div>
                <div className="font-semibold text-foreground">Freighter Wallet</div>
                <div className="text-[10px] text-brand-gate uppercase tracking-wider font-mono">Verified Onchain</div>
              </div>
              <div>
                <div className="font-semibold text-foreground">Escrow Management</div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-mono">Simple & Secure</div>
              </div>
              <div>
                <div className="font-semibold text-foreground">Onchain Transparency</div>
                <div className="text-[10px] text-brand-gate uppercase tracking-wider font-mono">Real-Time Data</div>
              </div>
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div role="region" aria-label="Escrow workspace mode" className="flex border-b border-border overflow-x-auto overscroll-x-contain">
          <button
            id="escrow-tab-create"
            type="button"
            aria-pressed={activeTab === "create"}
            aria-controls="escrow-panel-create"
            onClick={() => setActiveTab("create")}
            onKeyDown={(e) => handleHorizontalButtonKeyDown(e, ["create", "manage"] as const, activeTab, setActiveTab)}
            className={`min-h-12 shrink-0 pb-3 px-4 sm:px-6 font-semibold text-sm transition-all border-b-2 flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              activeTab === "create"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Lock className="w-4 h-4" aria-hidden="true" />
            <span>Deposit Milestone Escrow</span>
          </button>
          <button
            id="escrow-tab-manage"
            type="button"
            aria-pressed={activeTab === "manage"}
            aria-controls="escrow-panel-manage"
            onClick={() => setActiveTab("manage")}
            onKeyDown={(e) => handleHorizontalButtonKeyDown(e, ["create", "manage"] as const, activeTab, setActiveTab)}
            className={`min-h-12 shrink-0 pb-3 px-4 sm:px-6 font-semibold text-sm transition-all border-b-2 flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              activeTab === "manage"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <History className="w-4 h-4" aria-hidden="true" />
            <span>Manage Escrow (Release / Refund / Dispute)</span>
          </button>
        </div>

        {/* Tab Content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {activeTab === "create" ? (
            /* Create Escrow Form */
            <Card id="escrow-panel-create" className="lg:col-span-2">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                    <Lock className="w-5 h-5" aria-hidden="true" />
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
                    <label htmlFor="create-beneficiary" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Beneficiary Stellar Public Key
                    </label>
                    <Input
                      id="create-beneficiary"
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
                    <span id="create-token-preset-label" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                      <Coins className="w-3.5 h-3.5" aria-hidden="true" />
                      Select Token Asset
                    </span>
                    <div role="group" aria-labelledby="create-token-preset-label" className="flex gap-2">
                      <button
                        type="button"
                        aria-pressed={tokenPreset === "xlm"}
                        onClick={() => handleTokenPresetChange("xlm")}
                        onKeyDown={(e) => handleHorizontalButtonKeyDown(e, ["xlm", "usdc", "custom"] as const, tokenPreset, handleTokenPresetChange)}
                        className={`flex-1 py-2 px-3 rounded-xl border text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                          tokenPreset === "xlm"
                            ? "bg-primary/15 border-primary text-primary font-bold"
                            : "bg-input/40 border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Native SAC (XLM)
                      </button>
                      <button
                        type="button"
                        aria-pressed={tokenPreset === "usdc"}
                        onClick={() => handleTokenPresetChange("usdc")}
                        onKeyDown={(e) => handleHorizontalButtonKeyDown(e, ["xlm", "usdc", "custom"] as const, tokenPreset, handleTokenPresetChange)}
                        className={`flex-1 py-2 px-3 rounded-xl border text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                          tokenPreset === "usdc"
                            ? "bg-primary/15 border-primary text-primary font-bold"
                            : "bg-input/40 border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        USDC SAC
                      </button>
                      <button
                        type="button"
                        aria-pressed={tokenPreset === "custom"}
                        onClick={() => handleTokenPresetChange("custom")}
                        onKeyDown={(e) => handleHorizontalButtonKeyDown(e, ["xlm", "usdc", "custom"] as const, tokenPreset, handleTokenPresetChange)}
                        className={`flex-1 py-2 px-3 rounded-xl border text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
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
                      <label htmlFor="create-amount" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Amount (Tokens)
                      </label>
                      <Input
                        id="create-amount"
                        type="number"
                        step="0.0000001"
                        placeholder="100.00"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="create-lock-days" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Lock Duration (Days)
                      </label>
                      <Input
                        id="create-lock-days"
                        type="number"
                        placeholder="7"
                        value={lockDurationDays}
                        onChange={(e) => setLockDurationDays(e.target.value)}
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <span id="create-fee-label" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block">
                        Est. Protocol Fee (2.0%)
                      </span>
                      <output
                        htmlFor="create-amount"
                        aria-labelledby="create-fee-label"
                        className="h-11 flex items-center px-4 rounded-xl border border-border bg-muted/40 font-mono text-sm text-muted-foreground"
                      >
                        {amount ? `${protocolFeeEst} tokens` : "0.00 tokens"}
                      </output>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="create-token-address" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      SAC Token Contract Address
                    </label>
                    <Input
                      id="create-token-address"
                      type="text"
                      value={tokenAddress}
                      onChange={(e) => setTokenAddress(e.target.value)}
                      className="font-mono text-xs"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="create-routing-info" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Off-Ramp Target (SEP-9 / SEP-31 Banking Coordinates)
                    </label>
                    <Input
                      id="create-routing-info"
                      type="text"
                      placeholder="e.g. IBAN: DE89370400440532013000 / Sort Code: 04-00-04"
                      value={routingInfo}
                      onChange={(e) => setRoutingInfo(e.target.value)}
                      aria-describedby="create-routing-hint"
                      required
                    />
                    <p id="create-routing-hint" className="text-xs text-muted-foreground">
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
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
                        <span>Preparing Profile Hash...</span>
                      </>
                    )}
                    {txState === "simulating" && (
                      <>
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
                        <span>Simulating Soroban Transaction...</span>
                      </>
                    )}
                    {txState === "awaiting-signature" && (
                      <>
                        <FileCheck className="w-4 h-4 mr-2 animate-bounce" aria-hidden="true" />
                        <span>Awaiting Freighter Signature...</span>
                      </>
                    )}
                    {txState === "submitting" && (
                      <>
                        <Send className="w-4 h-4 mr-2 animate-pulse" aria-hidden="true" />
                        <span>Submitting to Testnet RPC...</span>
                      </>
                    )}
                    {txState === "pending" && (
                      <>
                        <Clock className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
                        <span>Authoritatively Polling Confirmation...</span>
                      </>
                    )}
                    {(txState === "idle" ||
                      txState === "confirmed" ||
                      txState === "failed" ||
                      txState === "wallet-required") && (
                      <>
                        <span>Initialize Escrow on Testnet</span>
                        <ArrowRight className="w-4 h-4 ml-2" aria-hidden="true" />
                      </>
                    )}
                  </Button>
                </form>

                {/* Status Semantics Banner */}
                {statusMessage && (
                  <div
                    role={txState === "failed" || txState === "wallet-required" ? "alert" : "status"}
                    aria-live={txState === "failed" || txState === "wallet-required" ? "assertive" : "polite"}
                    className={`mt-5 p-4 rounded-xl border text-sm flex items-start gap-3 ${
                      txState === "confirmed"
                        ? "bg-primary/10 border-primary/20 text-primary"
                        : txState === "failed" || txState === "wallet-required"
                        ? "bg-destructive/10 border-destructive/20 text-destructive"
                        : "bg-muted border-border text-foreground"
                    }`}
                  >
                    {txState === "confirmed" ? (
                      <CheckCircle2 className="w-5 h-5 shrink-0 text-primary" aria-hidden="true" />
                    ) : txState === "failed" || txState === "wallet-required" ? (
                      <AlertTriangle className="w-5 h-5 shrink-0 text-destructive" aria-hidden="true" />
                    ) : (
                      <RefreshCw className="w-5 h-5 shrink-0 text-primary animate-spin" aria-hidden="true" />
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
                            aria-label={`View transaction ${txHash.slice(0, 10)}...${txHash.slice(-6)} on Stellar Expert (opens in new tab)`}
                            className="font-mono text-xs text-primary hover:underline inline-flex items-center gap-1"
                          >
                            View Explorer Transaction: {txHash.slice(0, 10)}...{txHash.slice(-6)}
                            <ExternalLink className="w-3 h-3" aria-hidden="true" />
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
            <Card id="escrow-panel-manage" className="lg:col-span-2">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
                    <History className="w-5 h-5" aria-hidden="true" />
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
                    <label htmlFor="manage-escrow-id" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Escrow Counter ID
                    </label>
                    <Input
                      id="manage-escrow-id"
                      type="number"
                      placeholder="1"
                      value={manageEscrowId}
                      onChange={(e) => setManageEscrowId(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <span id="manage-action-label" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block">
                      Target Action
                    </span>
                    <div role="group" aria-labelledby="manage-action-label" className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        aria-pressed={manageAction === "release"}
                        onClick={() => setManageAction("release")}
                        onKeyDown={(e) => handleHorizontalButtonKeyDown(e, ["release", "refund", "dispute"] as const, manageAction, setManageAction)}
                        className={`py-3 px-3 rounded-xl border text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                          manageAction === "release"
                            ? "bg-primary/15 border-primary text-primary font-bold"
                            : "bg-input/40 border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Release to Anchor
                      </button>
                      <button
                        type="button"
                        aria-pressed={manageAction === "refund"}
                        onClick={() => setManageAction("refund")}
                        onKeyDown={(e) => handleHorizontalButtonKeyDown(e, ["release", "refund", "dispute"] as const, manageAction, setManageAction)}
                        className={`py-3 px-3 rounded-xl border text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                          manageAction === "refund"
                            ? "bg-primary/15 border-primary text-primary font-bold"
                            : "bg-input/40 border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Claim Refund
                      </button>
                      <button
                        type="button"
                        aria-pressed={manageAction === "dispute"}
                        onClick={() => setManageAction("dispute")}
                        onKeyDown={(e) => handleHorizontalButtonKeyDown(e, ["release", "refund", "dispute"] as const, manageAction, setManageAction)}
                        className={`py-3 px-3 rounded-xl border text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
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
                      <label htmlFor="manage-anchor-address" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Anchor Disbursement Payout Address
                      </label>
                      <Input
                        id="manage-anchor-address"
                        type="text"
                        placeholder="G... (Leave empty to use connected wallet)"
                        value={anchorDisbursementAddress}
                        onChange={(e) => setAnchorDisbursementAddress(e.target.value)}
                        aria-describedby="manage-anchor-hint"
                        className="font-mono text-xs"
                      />
                      <p id="manage-anchor-hint" className="text-xs text-muted-foreground">
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
                      <label htmlFor="manage-dispute-split" className="font-bold text-foreground block uppercase flex items-center gap-1.5">
                        <Scale className="w-4 h-4 text-primary" aria-hidden="true" />
                        Dispute Settlement Split (Arbiter Role)
                      </label>
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs">
                          <span>Payer Share: {parseInt(payerDisputeBps, 10) / 100}%</span>
                          <span>Beneficiary Share: {(10000 - parseInt(payerDisputeBps, 10)) / 100}%</span>
                        </div>
                        <input
                          id="manage-dispute-split"
                          type="range"
                          min="0"
                          max="10000"
                          step="500"
                          value={payerDisputeBps}
                          onChange={(e) => setPayerDisputeBps(e.target.value)}
                          aria-valuemin={0}
                          aria-valuemax={10000}
                          aria-valuenow={parseInt(payerDisputeBps, 10)}
                          aria-valuetext={`${parseInt(payerDisputeBps, 10) / 100}% payer, ${(10000 - parseInt(payerDisputeBps, 10)) / 100}% beneficiary`}
                          className="w-full accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
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
                    role={txState === "failed" || txState === "wallet-required" ? "alert" : "status"}
                    aria-live={txState === "failed" || txState === "wallet-required" ? "assertive" : "polite"}
                    className={`mt-5 p-4 rounded-xl border text-sm flex items-start gap-3 ${
                      txState === "confirmed"
                        ? "bg-primary/10 border-primary/20 text-primary"
                        : txState === "failed" || txState === "wallet-required"
                        ? "bg-destructive/10 border-destructive/20 text-destructive"
                        : "bg-muted border-border text-foreground"
                    }`}
                  >
                    {txState === "confirmed" ? (
                      <CheckCircle2 className="w-5 h-5 shrink-0 text-primary" aria-hidden="true" />
                    ) : txState === "failed" || txState === "wallet-required" ? (
                      <AlertTriangle className="w-5 h-5 shrink-0 text-destructive" aria-hidden="true" />
                    ) : (
                      <RefreshCw className="w-5 h-5 shrink-0 text-primary animate-spin" aria-hidden="true" />
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
                            aria-label={`View transaction ${txHash.slice(0, 10)}...${txHash.slice(-6)} on Stellar Expert (opens in new tab)`}
                            className="font-mono text-xs text-primary hover:underline inline-flex items-center gap-1"
                          >
                            View Explorer Transaction: {txHash.slice(0, 10)}...{txHash.slice(-6)}
                            <ExternalLink className="w-3 h-3" aria-hidden="true" />
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
          <aside aria-label="Protocol guardrails" className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-lg bg-secondary/20 text-secondary-foreground border border-secondary/30">
                    <ShieldCheck className="w-5 h-5 text-primary" aria-hidden="true" />
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
                    <RefreshCw className="w-3.5 h-3.5 text-primary animate-spin" aria-hidden="true" />
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
          </aside>
        </div>
      </main>

      {/* Footer */}
      <footer aria-label="Site footer" className="border-t border-border/80 py-6 bg-card/40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-muted-foreground">
          <span>SorobanAnchor Gate — Non-Custodial Milestone Escrow & Anchor Bridge</span>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/Sorobo-Gate/soroban-anchor-gate-contract"
              target="_blank"
              rel="noreferrer"
              aria-label="Contract Repo on GitHub (opens in new tab)"
              className="hover:text-primary transition"
            >
              Contract Repo
            </a>
            <a
              href="https://github.com/Sorobo-Gate/soroban-anchor-gate-app"
              target="_blank"
              rel="noreferrer"
              aria-label="App Repo on GitHub (opens in new tab)"
              className="hover:text-primary transition"
            >
              App Repo
            </a>
          </div>
        </div>
      </footer>

      <SimulationModal
        open={preflight !== null}
        state={preflight?.state ?? { phase: "simulating" }}
        actionLabel={preflight?.actionLabel ?? ""}
        onConfirm={handlePreflightConfirm}
        onCancel={handlePreflightCancel}
        readyExtra={
          preflight?.funding ? (
            <details className="rounded-xl border border-border bg-muted/20 p-3">
              <summary className="min-h-12 flex items-center cursor-pointer text-sm font-medium text-foreground">
                Or fund from a mobile wallet (scan QR)
              </summary>
              <p className="mt-2 mb-3 text-xs text-muted-foreground">
                Scan with a SEP-0007 compatible wallet holding the connected account to sign this exact
                escrow deposit. The transaction expires in 5 minutes.
              </p>
              <PaymentQR
                destination={config.contractId}
                amount={preflight.funding.amount}
                assetCode={preflight.funding.assetCode}
                memoHashHex={preflight.funding.memoHashHex}
                xdr={preflight.funding.xdr}
                networkPassphrase={config.networkPassphrase}
                message="Fund SorobanAnchor Gate escrow"
                size={192}
              />
            </details>
          ) : undefined
        }
      />
    </div>
  );
}
