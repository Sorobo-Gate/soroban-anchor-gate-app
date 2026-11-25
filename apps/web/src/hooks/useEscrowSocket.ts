"use client";

import * as React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

/**
 * Real-time escrow state synchronisation with the Go relay WebSocket hub
 * (`services/relay/internal/ws`).
 *
 * Protocol (mirrors hub.go / client.go):
 *  - client → relay: `{"action":"subscribe","channel":"subscribe:escrow:<id>"}`
 *  - relay → client: JSON `EscrowUpdate` objects. Several queued updates may be
 *    coalesced into a single text frame separated by `\n` (see writePump).
 */

/** Wire format of the relay's `ws.EscrowUpdate` struct. */
export interface EscrowUpdate {
  escrow_id: string;
  event_id?: string;
  status: string;
  payout_amount?: string;
  profile_hash_hex?: string;
  /** RFC 3339 timestamp. */
  timestamp: string;
}

/** Normalised escrow record kept in the React Query cache. */
export interface EscrowCacheEntry {
  id: string;
  status: string;
  payoutAmount?: string;
  profileHashHex?: string;
  lastEventId?: string;
  /** RFC 3339 timestamp of the most recently applied update. */
  updatedAt?: string;
  [key: string]: unknown;
}

export type EscrowSocketStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";

export const DEFAULT_RELAY_WS_URL = "ws://localhost:8080/ws";

export interface BackoffOptions {
  /** Delay before the first reconnect attempt. */
  baseMs: number;
  /** Upper bound on any single delay. */
  maxMs: number;
  /** Exponential growth factor per attempt. */
  factor: number;
  /** Fractional +/- jitter (0.2 = ±20 %) to avoid thundering-herd reconnects. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
};

/** React Query key for a single escrow. */
export function escrowQueryKey(escrowId: string): readonly ["escrow", string] {
  return ["escrow", escrowId] as const;
}

/** React Query key prefix for escrow list queries (e.g. `["escrows", filters]`). */
export const ESCROW_LIST_QUERY_KEY = ["escrows"] as const;

/** Relay hub channel name for an escrow (matches `BroadcastEscrowUpdate`). */
export function escrowChannel(escrowId: string): string {
  return `subscribe:escrow:${escrowId}`;
}

export function buildSubscribeMessage(escrowId: string): string {
  return JSON.stringify({ action: "subscribe", channel: escrowChannel(escrowId) });
}

export function buildUnsubscribeMessage(escrowId: string): string {
  return JSON.stringify({ action: "unsubscribe", channel: escrowChannel(escrowId) });
}

/** Rejects ids that would produce an ambiguous or injectable channel name. */
export function isValidEscrowId(escrowId: unknown): escrowId is string {
  return typeof escrowId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(escrowId);
}

/**
 * Resolves the relay WebSocket URL: explicit override → NEXT_PUBLIC_RELAY_WS_URL → default.
 * Only `ws:` / `wss:` URLs are accepted.
 */
export function resolveRelayWsUrl(override?: string): string {
  const candidate = (override || process.env.NEXT_PUBLIC_RELAY_WS_URL || DEFAULT_RELAY_WS_URL).trim();
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid relay WebSocket URL: "${candidate}".`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`Relay WebSocket URL must use ws:// or wss:// (got "${parsed.protocol}").`);
  }
  return parsed.toString();
}

/**
 * Exponential backoff delay for the given (0-based) reconnect attempt, capped at
 * `maxMs` and spread by ±`jitter`. `random` is injectable for deterministic tests.
 */
export function computeBackoffDelay(
  attempt: number,
  options: Partial<BackoffOptions> = {},
  random: () => number = Math.random
): number {
  const { baseMs, maxMs, factor, jitter } = { ...DEFAULT_BACKOFF, ...options };
  const safeAttempt = Math.max(0, Math.floor(Number.isFinite(attempt) ? attempt : 0));
  const exponential = Math.min(maxMs, baseMs * Math.pow(factor, safeAttempt));
  const spread = exponential * Math.min(Math.max(jitter, 0), 1);
  const jittered = exponential - spread + random() * spread * 2;
  return Math.round(Math.min(maxMs, Math.max(0, jittered)));
}

function isEscrowUpdate(value: unknown): value is EscrowUpdate {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.escrow_id === "string" &&
    v.escrow_id.length > 0 &&
    typeof v.status === "string" &&
    v.status.length > 0 &&
    typeof v.timestamp === "string" &&
    !Number.isNaN(Date.parse(v.timestamp)) &&
    (v.event_id === undefined || typeof v.event_id === "string") &&
    (v.payout_amount === undefined || typeof v.payout_amount === "string") &&
    (v.profile_hash_hex === undefined || typeof v.profile_hash_hex === "string")
  );
}

/**
 * Parses a raw relay frame into validated updates. Handles newline-batched frames,
 * silently drops malformed JSON / unexpected shapes, and (optionally) filters to one escrow.
 */
export function parseRelayFrame(data: unknown, expectedEscrowId?: string): EscrowUpdate[] {
  if (typeof data !== "string" || data.length === 0) return [];
  const updates: EscrowUpdate[] = [];
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isEscrowUpdate(parsed)) continue;
    if (expectedEscrowId !== undefined && parsed.escrow_id !== expectedEscrowId) continue;
    updates.push(parsed);
  }
  return updates;
}

/**
 * Merges a relay update into a cached escrow record. Returns the previous object
 * unchanged (referentially) for duplicate `event_id`s or out-of-order (older) updates,
 * so React Query does not trigger needless re-renders.
 */
export function mergeEscrowUpdate<T extends Partial<EscrowCacheEntry>>(
  previous: T | undefined,
  update: EscrowUpdate
): T | EscrowCacheEntry {
  if (previous) {
    if (update.event_id && previous.lastEventId === update.event_id) return previous;
    if (previous.updatedAt && Date.parse(update.timestamp) < Date.parse(previous.updatedAt)) {
      return previous;
    }
  }
  return {
    ...(previous ?? {}),
    id: update.escrow_id,
    status: update.status,
    ...(update.payout_amount !== undefined ? { payoutAmount: update.payout_amount } : {}),
    ...(update.profile_hash_hex !== undefined ? { profileHashHex: update.profile_hash_hex } : {}),
    ...(update.event_id !== undefined ? { lastEventId: update.event_id } : {}),
    updatedAt: update.timestamp,
  };
}

/** Minimal QueryClient surface used here — lets tests pass a real or fake client. */
export type EscrowQueryCache = Pick<QueryClient, "setQueryData" | "setQueriesData">;

/**
 * Writes an update into the React Query cache immediately:
 *  - the detail query `["escrow", id]`
 *  - any list query under `["escrows", ...]` holding an array of records with a matching `id`.
 */
export function applyEscrowUpdateToCache(queryClient: EscrowQueryCache, update: EscrowUpdate): void {
  queryClient.setQueryData<EscrowCacheEntry>(escrowQueryKey(update.escrow_id), (previous) =>
    mergeEscrowUpdate(previous, update) as EscrowCacheEntry
  );
  queryClient.setQueriesData<unknown>({ queryKey: ESCROW_LIST_QUERY_KEY }, (previous: unknown) => {
    if (!Array.isArray(previous)) return previous;
    let changed = false;
    const next = previous.map((row) => {
      if (row && typeof row === "object" && (row as { id?: unknown }).id === update.escrow_id) {
        const merged = mergeEscrowUpdate(row as EscrowCacheEntry, update);
        if (merged !== row) changed = true;
        return merged;
      }
      return row;
    });
    return changed ? next : previous;
  });
}

/** Subset of the browser WebSocket API the client relies on (injectable for tests). */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_OPEN = 1;
/** Normal closure — the client asked to stop, so we must not reconnect. */
const NORMAL_CLOSURE = 1000;

export interface EscrowSocketClientOptions {
  url: string;
  escrowId: string;
  onUpdate: (update: EscrowUpdate) => void;
  onStatusChange?: (status: EscrowSocketStatus, info: { attempt: number; delayMs?: number }) => void;
  createSocket?: WebSocketFactory;
  backoff?: Partial<BackoffOptions>;
  /** Stop reconnecting after this many consecutive failures (default: unlimited). */
  maxRetries?: number;
  random?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * Framework-agnostic connection manager: connects, subscribes, parses frames and
 * reconnects with exponential backoff. `useEscrowSocket` is a thin React wrapper.
 */
export class EscrowSocketClient {
  private socket: WebSocketLike | null = null;
  private retryHandle: unknown = null;
  private attempt = 0;
  private stopped = true;
  private readonly opts: EscrowSocketClientOptions;

  constructor(options: EscrowSocketClientOptions) {
    if (!isValidEscrowId(options.escrowId)) {
      throw new Error(`Invalid escrow id: "${options.escrowId}".`);
    }
    this.opts = options;
  }

  get reconnectAttempts(): number {
    return this.attempt;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearRetry();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        if (socket.readyState === WS_OPEN) socket.send(buildUnsubscribeMessage(this.opts.escrowId));
      } catch {
        // socket already unusable — ignore
      }
      try {
        socket.close(NORMAL_CLOSURE, "client stopped");
      } catch {
        // ignore
      }
    }
    this.emit("closed");
  }

  private emit(status: EscrowSocketStatus, delayMs?: number): void {
    this.opts.onStatusChange?.(status, { attempt: this.attempt, delayMs });
  }

  private clearRetry(): void {
    if (this.retryHandle !== null) {
      (this.opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.retryHandle);
      this.retryHandle = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.emit(this.attempt === 0 ? "connecting" : "reconnecting");

    const factory: WebSocketFactory =
      this.opts.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);

    let socket: WebSocketLike;
    try {
      socket = factory(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      try {
        socket.send(buildSubscribeMessage(this.opts.escrowId));
      } catch {
        // close handler will drive the reconnect
      }
      this.emit("open");
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      for (const update of parseRelayFrame(event.data, this.opts.escrowId)) {
        this.opts.onUpdate(update);
      }
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.emit("error");
      if (socket.readyState !== 1) {
        this.socket = null;
        this.scheduleReconnect();
      }
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const { maxRetries } = this.opts;
    if (maxRetries !== undefined && this.attempt >= maxRetries) {
      this.stopped = true;
      this.emit("error");
      return;
    }
    const delayMs = computeBackoffDelay(this.attempt, this.opts.backoff, this.opts.random);
    this.attempt += 1;
    this.emit("reconnecting", delayMs);
    const schedule = this.opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.retryHandle = schedule(() => {
      this.retryHandle = null;
      this.connect();
    }, delayMs);
  }
}

export interface UseEscrowSocketOptions {
  /** Relay WebSocket URL; defaults to NEXT_PUBLIC_RELAY_WS_URL or ws://localhost:8080/ws. */
  url?: string;
  /** Explicit QueryClient; otherwise the nearest `QueryClientProvider` is used. */
  queryClient?: QueryClient;
  /** Set false to pause the connection (e.g. while the tab is hidden). Default true. */
  enabled?: boolean;
  backoff?: Partial<BackoffOptions>;
  maxRetries?: number;
  onUpdate?: (update: EscrowUpdate) => void;
  createSocket?: WebSocketFactory;
}

export interface UseEscrowSocketResult {
  status: EscrowSocketStatus;
  lastUpdate: EscrowUpdate | null;
  reconnectAttempts: number;
  error: string | null;
}

/**
 * Subscribes to real-time state changes for escrow `id` from the relay and writes each
 * update straight into the React Query cache, so every `useQuery(["escrow", id])`
 * consumer (escrow cards, tables) re-renders without a manual page reload.
 */
export function useEscrowSocket(
  id: string | null | undefined,
  options: UseEscrowSocketOptions = {}
): UseEscrowSocketResult {
  const queryClient = useQueryClient(options.queryClient);
  const { url, enabled = true, backoff, maxRetries, createSocket } = options;
  const [state, setState] = React.useState<UseEscrowSocketResult>({
    status: "idle",
    lastUpdate: null,
    reconnectAttempts: 0,
    error: null,
  });

  // Keep the latest callback without re-opening the socket on every render.
  const onUpdateRef = React.useRef(options.onUpdate);
  React.useEffect(() => {
    onUpdateRef.current = options.onUpdate;
  }, [options.onUpdate]);

  const backoffKey = JSON.stringify(backoff ?? {});

  // Validate inputs during render so misconfiguration surfaces without an effect round-trip.
  const setup = React.useMemo((): { url: string; error: null } | { url: null; error: string } | null => {
    if (!enabled || !id) return null;
    try {
      if (!isValidEscrowId(id)) throw new Error(`Invalid escrow id: "${id}".`);
      return { url: resolveRelayWsUrl(url), error: null };
    } catch (err: unknown) {
      return { url: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [enabled, id, url]);
  const resolvedUrl = setup?.url ?? null;

  React.useEffect(() => {
    if (!id || !resolvedUrl || typeof window === "undefined") return;

    let client: EscrowSocketClient;
    try {
      client = new EscrowSocketClient({
        url: resolvedUrl,
        escrowId: id,
        backoff: JSON.parse(backoffKey) as Partial<BackoffOptions>,
        maxRetries,
        createSocket,
        onUpdate: (update) => {
          applyEscrowUpdateToCache(queryClient, update);
          setState((s) => ({ ...s, lastUpdate: update }));
          onUpdateRef.current?.(update);
        },
        onStatusChange: (status, info) => {
          setState((s) => ({
            ...s,
            status,
            reconnectAttempts: info.attempt,
            error:
              status === "error"
                ? "Lost connection to the relay. Retrying…"
                : status === "open"
                  ? null
                  : s.error,
          }));
        },
      });
    } catch {
      return;
    }

    client.start();
    return () => client.stop();
  }, [id, resolvedUrl, backoffKey, maxRetries, createSocket, queryClient]);

  if (!setup) return { ...state, status: "idle", error: null };
  if (setup.error !== null) return { ...state, status: "error", error: setup.error };
  return state;
}

export default useEscrowSocket;
