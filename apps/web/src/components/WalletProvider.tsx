"use client";

import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import {
  getAddress,
  getNetworkDetails,
  isConnected,
  requestAccess,
} from "@stellar/freighter-api";
import { Button } from "@/components/ui/button";
import { trapDialogFocus } from "@/lib/a11y";

export const WALLET_SESSION_STORAGE_KEY =
  "soroban-anchor-gate.wallet-session.v1";

export interface WalletSession {
  address: string;
  networkPassphrase?: string;
  connectedAt: number;
}

/** Minimal Storage surface so the session helpers are testable without a browser. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WalletNetworkDetails {
  network?: string;
  networkPassphrase?: string;
}

const STELLAR_PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;

export function isValidWalletAddress(address: unknown): address is string {
  return (
    typeof address === "string" &&
    STELLAR_PUBLIC_KEY_PATTERN.test(address.trim())
  );
}

export function readWalletSession(
  storage: StorageLike | null | undefined
): WalletSession | null {
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(WALLET_SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<WalletSession> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const { address } = parsed;
    if (!isValidWalletAddress(address)) {
      return null;
    }

    return {
      address: address.trim(),
      networkPassphrase:
        typeof parsed.networkPassphrase === "string"
          ? parsed.networkPassphrase
          : undefined,
      connectedAt:
        typeof parsed.connectedAt === "number" &&
        Number.isFinite(parsed.connectedAt)
          ? parsed.connectedAt
          : 0,
    };
  } catch {
    return null;
  }
}

export function writeWalletSession(
  storage: StorageLike | null | undefined,
  session: WalletSession
): boolean {
  if (!storage || !isValidWalletAddress(session.address)) {
    return false;
  }

  try {
    storage.setItem(
      WALLET_SESSION_STORAGE_KEY,
      JSON.stringify({
        address: session.address.trim(),
        networkPassphrase: session.networkPassphrase,
        connectedAt: session.connectedAt,
      })
    );
    return true;
  } catch {
    return false;
  }
}

export function clearWalletSession(
  storage: StorageLike | null | undefined
): void {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(WALLET_SESSION_STORAGE_KEY);
  } catch {
    // Storage may be disabled (private mode); there is nothing to clear.
  }
}

export function isWalletNetworkMismatch(
  details: WalletNetworkDetails | null | undefined,
  expectedPassphrase: string
): boolean {
  const expected = expectedPassphrase.trim();
  if (!details || expected === "") {
    return false;
  }

  const detected = (details.networkPassphrase || details.network || "").trim();
  if (detected === "") {
    return false;
  }

  return detected !== expected;
}

export function describeNetwork(passphrase: string): string {
  const value = passphrase.trim();
  if (/Test SDF Network/i.test(value)) {
    return "Stellar Testnet";
  }
  if (/Public Global Stellar Network/i.test(value)) {
    return "Stellar Mainnet";
  }
  if (/Futurenet|Future Network/i.test(value)) {
    return "Stellar Futurenet";
  }
  if (/Standalone|Local/i.test(value)) {
    return "Stellar Standalone";
  }
  return "a custom Stellar network";
}

function getFreighterError(result: unknown): string | null {
  if (!result || typeof result !== "object" || !("error" in result)) {
    return null;
  }

  const error = (result as { error?: unknown }).error;
  if (!error) {
    return null;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : String(error);
  }
  return String(error);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getDefaultStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface WalletContextValue {
  address: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  expectedNetworkPassphrase: string;
  /** True when Freighter is connected to a network other than the expected one. */
  networkMismatch: boolean;
  /** Passphrase Freighter is currently connected to, when available. */
  detectedNetworkPassphrase: string | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  refresh: () => Promise<void>;
  /** Re-runs the network check after the user switches networks in Freighter. */
  retryNetworkCheck: () => Promise<void>;
  dismissNetworkWarning: () => void;
}

const WalletContext = React.createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const context = React.useContext(WalletContext);
  if (!context) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return context;
}

export interface NetworkMismatchModalProps {
  expectedNetworkPassphrase: string;
  detectedNetworkPassphrase?: string | null;
  onRetry: () => void | Promise<void>;
  onDismiss: () => void;
  isRetrying?: boolean;
}

/**
 * Prominent one-click guard shown when Freighter is connected to the wrong
 * Stellar network. The retry button re-checks after the user switches networks
 * inside the Freighter extension (Freighter exposes no programmatic switch).
 */
export function NetworkMismatchModal({
  expectedNetworkPassphrase,
  detectedNetworkPassphrase,
  onRetry,
  onDismiss,
  isRetrying = false,
}: NetworkMismatchModalProps) {
  const expectedNetwork = describeNetwork(expectedNetworkPassphrase);
  const detectedNetwork = detectedNetworkPassphrase
    ? describeNetwork(detectedNetworkPassphrase)
    : "an unknown network";
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const dismissRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dismissRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }
      trapDialogFocus(dialogRef.current, event);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [onDismiss]);

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      data-testid="network-mismatch-modal"
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="network-mismatch-title"
        aria-describedby="network-mismatch-description"
        className="w-full max-w-md rounded-2xl border border-destructive/30 bg-card p-6 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <span className="rounded-xl border border-destructive/30 bg-destructive/10 p-2.5 text-destructive">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="space-y-1">
            <h2
              id="network-mismatch-title"
              className="text-base font-semibold text-foreground"
            >
              Wrong Freighter network
            </h2>
            <p
              id="network-mismatch-description"
              className="text-sm text-muted-foreground"
            >
              Freighter is connected to <b>{detectedNetwork}</b>, but this
              application operates on <b>{expectedNetwork}</b>. Signing on the
              wrong network can cause irreversible fund loss.
            </p>
          </div>
        </div>

        <p className="mt-4 rounded-xl border border-border bg-input/40 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          Expected passphrase: {expectedNetworkPassphrase}
        </p>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button ref={dismissRef} type="button" variant="outline" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button type="button" onClick={onRetry} disabled={isRetrying}>
            <RefreshCw
              className={`mr-2 h-4 w-4 ${isRetrying ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {isRetrying ? "Checking network..." : "Switch to " + expectedNetwork + " & retry"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface WalletProviderProps {
  children?: React.ReactNode;
  expectedNetworkPassphrase: string;
  /** Override the storage backend (defaults to window.localStorage). */
  storage?: StorageLike | null;
}

export function WalletProvider({
  children,
  expectedNetworkPassphrase,
  storage,
}: WalletProviderProps) {
  const resolvedStorage = React.useMemo(
    () => (storage === undefined ? getDefaultStorage() : storage),
    [storage]
  );

  const [address, setAddress] = React.useState<string | null>(null);
  const [isConnecting, setIsConnecting] = React.useState(false);
  const [networkMismatch, setNetworkMismatch] = React.useState(false);
  const [detectedNetworkPassphrase, setDetectedNetworkPassphrase] = React.useState<
    string | null
  >(null);
  const [error, setError] = React.useState<string | null>(null);
  const [warningDismissed, setWarningDismissed] = React.useState(false);

  const syncWallet = React.useCallback(
    async (requestPermission: boolean) => {
      setIsConnecting(true);
      setError(null);

      try {
        const connection = await isConnected();
        const connectionError = getFreighterError(connection);
        if (connectionError) {
          throw new Error(connectionError);
        }

        if (!connection.isConnected) {
          setAddress(null);
          setNetworkMismatch(false);
          setDetectedNetworkPassphrase(null);
          clearWalletSession(resolvedStorage);
          return;
        }

        if (requestPermission) {
          const access = await requestAccess();
          const accessError = getFreighterError(access);
          if (accessError) {
            throw new Error(accessError);
          }
        }

        const addressResult = await getAddress();
        const addressError = getFreighterError(addressResult);
        if (addressError) {
          throw new Error(addressError);
        }
        if (!isValidWalletAddress(addressResult.address)) {
          throw new Error("Freighter returned an invalid wallet address.");
        }

        const nextAddress = addressResult.address.trim();
        let mismatch = false;
        let detected: string | null = null;

        try {
          const network = await getNetworkDetails();
          const networkError = getFreighterError(network);
          if (networkError) {
            throw new Error(networkError);
          }
          detected =
            (network.networkPassphrase || network.network || "").trim() || null;
          mismatch = isWalletNetworkMismatch(network, expectedNetworkPassphrase);
        } catch (networkError) {
          // Keep the wallet usable, but surface the failed network check.
          setError(toErrorMessage(networkError));
        }

        setAddress(nextAddress);
        setNetworkMismatch(mismatch);
        setDetectedNetworkPassphrase(detected);
        setWarningDismissed(false);
        writeWalletSession(resolvedStorage, {
          address: nextAddress,
          networkPassphrase: detected ?? undefined,
          connectedAt: Date.now(),
        });
      } catch (connectError) {
        setAddress(null);
        setNetworkMismatch(false);
        setDetectedNetworkPassphrase(null);
        setError(toErrorMessage(connectError));
        clearWalletSession(resolvedStorage);
      } finally {
        setIsConnecting(false);
      }
    },
    [expectedNetworkPassphrase, resolvedStorage]
  );

  React.useEffect(() => {
    let cancelled = false;

    // Restore the persisted session after mount (never during render, so SSR
    // and hydration start from the same disconnected snapshot). The effect
    // then revalidates the session against the live Freighter extension.
    const restoreSession = async () => {
      const session = readWalletSession(resolvedStorage);
      await Promise.resolve();
      if (!cancelled && session) {
        setAddress(session.address);
      }
      if (!cancelled) {
        await syncWallet(false);
      }
    };

    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, [resolvedStorage, syncWallet]);

  const connect = React.useCallback(async () => {
    await syncWallet(true);
  }, [syncWallet]);

  const refresh = React.useCallback(async () => {
    await syncWallet(false);
  }, [syncWallet]);

  const disconnect = React.useCallback(() => {
    setAddress(null);
    setNetworkMismatch(false);
    setDetectedNetworkPassphrase(null);
    setWarningDismissed(false);
    setError(null);
    clearWalletSession(resolvedStorage);
  }, [resolvedStorage]);

  const dismissNetworkWarning = React.useCallback(() => {
    setWarningDismissed(true);
  }, []);

  const value = React.useMemo<WalletContextValue>(
    () => ({
      address,
      isConnected: Boolean(address),
      isConnecting,
      expectedNetworkPassphrase,
      networkMismatch,
      detectedNetworkPassphrase,
      error,
      connect,
      disconnect,
      refresh,
      retryNetworkCheck: refresh,
      dismissNetworkWarning,
    }),
    [
      address,
      isConnecting,
      expectedNetworkPassphrase,
      networkMismatch,
      detectedNetworkPassphrase,
      error,
      connect,
      disconnect,
      refresh,
      dismissNetworkWarning,
    ]
  );

  return (
    <WalletContext.Provider value={value}>
      {children}
      {networkMismatch && !warningDismissed && (
        <NetworkMismatchModal
          expectedNetworkPassphrase={expectedNetworkPassphrase}
          detectedNetworkPassphrase={detectedNetworkPassphrase}
          onRetry={refresh}
          onDismiss={dismissNetworkWarning}
          isRetrying={isConnecting}
        />
      )}
    </WalletContext.Provider>
  );
}
