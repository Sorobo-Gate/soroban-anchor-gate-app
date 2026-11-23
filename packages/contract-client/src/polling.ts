/**
 * Transaction receipt polling with exponential backoff.
 *
 * Soroban RPC reports a submitted transaction as `PENDING` (or `NOT_FOUND`)
 * until it is included in a ledger. Polling at a fixed interval either wastes
 * requests on slow ledgers or is too slow on fast ones, so this module backs
 * off exponentially up to a configurable ceiling and gives up with actionable
 * diagnostics once the deadline passes.
 *
 * @packageDocumentation
 */

import { rpc } from "@stellar/stellar-sdk";
import { ClientConfig, validateClientConfig } from "./index";

/** Status reported for a transaction that has not yet settled. */
export type PendingTransactionStatus = "PENDING";

/** Terminal statuses returned by Soroban RPC. */
export type SettledTransactionStatus = "SUCCESS" | "FAILED";

/** Default time to wait for confirmation before throwing. */
export const DEFAULT_POLL_TIMEOUT_MS = 60_000;

/** Default first delay between polls. */
export const DEFAULT_POLL_INITIAL_DELAY_MS = 500;

/** Default ceiling for the exponentially growing delay. */
export const DEFAULT_POLL_MAX_DELAY_MS = 5_000;

/**
 * Minimal shape of a `getTransaction` response used by the poller.
 */
export interface TransactionRpcResponse {
  /** RPC status: `SUCCESS`, `FAILED`, `NOT_FOUND`, or a future `PENDING`. */
  status: string;
  /** Ledger sequence the transaction was included in, when settled. */
  ledger?: number;
  /** Ledger close time of inclusion, in Unix seconds. */
  createdAt?: number;
  /** Raw result XDR, kept as returned by the RPC server. */
  resultXdr?: unknown;
}

/**
 * Options for {@link pollTransactionStatus}.
 */
export interface PollTransactionOptions {
  /** Contract and RPC settings used to create the default RPC server. */
  config?: ClientConfig;
  /** Injectable RPC server, primarily for tests or custom transports. */
  server?: Pick<rpc.Server, "getTransaction">;
  /** Overall deadline in milliseconds. Defaults to 60 seconds. */
  timeoutMs?: number;
  /** First backoff delay in milliseconds. Defaults to 500. */
  initialDelayMs?: number;
  /** Upper bound for the backoff delay in milliseconds. Defaults to 5000. */
  maxDelayMs?: number;
  /** Injectable clock, in milliseconds, used to enforce the deadline. */
  now?: () => number;
  /** Injectable sleep function used between polls. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Successful transaction receipt.
 */
export interface TransactionReceipt {
  /** Transaction hash that was polled. */
  hash: string;
  /** Terminal status of the receipt. */
  status: SettledTransactionStatus;
  /** Ledger sequence the transaction was included in. */
  ledger?: number;
  /** Ledger close time of inclusion, in Unix seconds. */
  createdAt?: number;
  /** Number of `getTransaction` calls made. */
  attempts: number;
  /** Milliseconds elapsed between the first poll and settlement. */
  elapsedMs: number;
  /** Raw RPC response, including result XDR. */
  response: TransactionRpcResponse;
}

/** Default sleep implementation based on `setTimeout`. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalizes a Soroban RPC status into a known polling status.
 *
 * @param status - Raw status returned by the RPC server.
 * @returns `PENDING` for `NOT_FOUND`/`PENDING`, otherwise the input status.
 */
function normalizeStatus(status: string): string {
  return status === "NOT_FOUND" ? "PENDING" : status;
}

/**
 * Polls Soroban RPC until a transaction settles or the deadline expires.
 *
 * `PENDING` and `NOT_FOUND` responses are retried with exponential backoff,
 * starting at `initialDelayMs` and capped at `maxDelayMs`. `SUCCESS` resolves
 * with the receipt; `FAILED` rejects immediately. If the transaction is still
 * unconfirmed after `timeoutMs`, the rejection includes the hash, duration,
 * number of attempts, and last observed status.
 *
 * @param txHash - 64-character hex transaction hash.
 * @param options - Deadline, backoff settings, and an injectable RPC server.
 * @returns The successful transaction receipt.
 * @throws {Error} If the hash is invalid, the configuration is invalid, the
 *   transaction failed, or the deadline expired unconfirmed.
 */
export async function pollTransactionStatus(
  txHash: string,
  options: PollTransactionOptions = {}
): Promise<TransactionReceipt> {
  if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error("txHash must be 64 hexadecimal characters");
  }

  let server: Pick<rpc.Server, "getTransaction">;
  if (options.server) {
    server = options.server;
  } else {
    if (!options.config) {
      throw new Error("Either config or server must be provided");
    }
    validateClientConfig(options.config);
    server = new rpc.Server(options.config.rpcUrl, {
      allowHttp: options.config.rpcUrl.startsWith("http://"),
    });
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const initialDelayMs =
    options.initialDelayMs ?? DEFAULT_POLL_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_POLL_MAX_DELAY_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) {
    throw new Error("initialDelayMs must be a positive number");
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new Error("maxDelayMs must be at least initialDelayMs");
  }

  const started = now();
  let delay = initialDelayMs;
  let attempts = 0;
  let lastStatus = "PENDING";

  for (;;) {
    const elapsed = now() - started;
    if (elapsed >= timeoutMs) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for transaction ${txHash} ` +
          `(attempts=${attempts}, lastStatus=${lastStatus})`
      );
    }

    const response = (await server.getTransaction(txHash)) as TransactionRpcResponse;
    attempts++;
    lastStatus = normalizeStatus(response.status);

    if (lastStatus === "SUCCESS") {
      return {
        hash: txHash,
        status: "SUCCESS",
        ledger: response.ledger,
        createdAt: response.createdAt,
        attempts,
        elapsedMs: now() - started,
        response,
      };
    }

    if (lastStatus === "FAILED") {
      throw new Error(
        `Transaction ${txHash} failed` +
          (response.ledger !== undefined
            ? ` in ledger ${response.ledger}`
            : "") +
          ` (attempts=${attempts})`
      );
    }

    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) {
      continue;
    }

    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, maxDelayMs);
  }
}
