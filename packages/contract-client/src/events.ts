/**
 * Pull-based Soroban event observation for Anchor Gate escrows.
 *
 * @packageDocumentation
 */

import {
  nativeToScVal,
  rpc,
  scValToNative,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import type { ClientConfig } from "./index";

const DEFAULT_POLL_INTERVAL_MS = 4_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1_000;
const MAX_LEDGER_WINDOW = 256;
const U64_MAX = (1n << 64n) - 1n;

type EscrowEventName =
  | "created"
  | "disbursed"
  | "split_disb"
  | "refunded"
  | "keeper_refund"
  | "dispute_resolved"
  | "ClawbackHandled";

/** RPC metadata retained with every decoded escrow event. */
export interface EscrowEventMetadata {
  /** Stable event identifier supplied by Soroban RPC. */
  eventId: string;
  /** Contract that emitted the event. */
  contractId: string;
  /** Ledger sequence containing the event. */
  ledger: number;
  /** Ledger close time reported by RPC. */
  ledgerClosedAt: string;
  /** Transaction's position within the ledger. */
  transactionIndex: number;
  /** Operation's position within the transaction. */
  operationIndex: number;
  /** Transaction hash containing the event. */
  txHash: string;
}

/** Shared fields carried by every decoded escrow event. */
export interface EscrowEventBase {
  /** Contract-assigned positive `u64` escrow identifier. */
  escrowId: bigint;
  /** Ledger, transaction, and RPC event metadata. */
  metadata: EscrowEventMetadata;
}

/**
 * A decoded, escrow-scoped event emitted by the Anchor Gate contract.
 *
 * The contract currently emits these seven event shapes. Administrative
 * events, malformed payloads, and events for other escrows are not yielded.
 */
export type EscrowEvent =
  | (EscrowEventBase & {
      /** Event discriminator. */
      type: "created";
      /** Stellar account that funded the escrow. */
      payer: string;
      /** Amount deposited, in the token's smallest unit. */
      amount: bigint;
      /** SHA-256 routing profile hash as lowercase hexadecimal. */
      profileHashHex: string;
    })
  | (EscrowEventBase & {
      /** Event discriminator. */
      type: "disbursed";
      /** SHA-256 routing profile hash as lowercase hexadecimal. */
      profileHashHex: string;
      /** Amount disbursed, in the token's smallest unit. */
      amount: bigint;
    })
  | (EscrowEventBase & {
      /** Event discriminator. */
      type: "split_disb";
      /** Zero-based split destination index from the event topic. */
      index: number;
      /** Destination account for this split payment. */
      recipient: string;
      /** Amount sent to this destination, in the token's smallest unit. */
      amount: bigint;
      /** Commitment hash as lowercase hexadecimal. */
      commitmentHashHex: string;
    })
  | (EscrowEventBase & {
      /** Event discriminator. */
      type: "refunded";
      /** Amount returned to the payer, in the token's smallest unit. */
      amount: bigint;
    })
  | (EscrowEventBase & {
      /** Event discriminator. */
      type: "keeper_refund";
      /** Address that claimed the keeper refund. */
      caller: string;
      /** Keeper bounty amount, in the token's smallest unit. */
      bounty: bigint;
      /** Account that received the remaining refund. */
      payer: string;
      /** Refund amount after the keeper bounty. */
      refundAmount: bigint;
    })
  | (EscrowEventBase & {
      /** Event discriminator. */
      type: "dispute_resolved";
      /** Amount awarded to the payer, in the token's smallest unit. */
      payerAmount: bigint;
      /** Amount awarded to the beneficiary, in the token's smallest unit. */
      beneficiaryAmount: bigint;
    })
  | (EscrowEventBase & {
      /** Event discriminator. */
      type: "clawback_handled";
      /** Token contract whose balance was clawed back. */
      token: string;
      /** Deficit applied to this escrow, in the token's smallest unit. */
      deficit: bigint;
    });

/** Stable category for an error that ends an escrow event iterator. */
export type EscrowEventStreamErrorKind =
  | "rpc"
  | "invalid_response"
  | "retention_gap";

/** An unrecoverable polling or response error surfaced by `watchEscrow`. */
export class EscrowEventStreamError extends Error {
  /** Stable classification for caller handling. */
  public readonly kind: EscrowEventStreamErrorKind;

  constructor(
    message: string,
    kind: EscrowEventStreamErrorKind,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "EscrowEventStreamError";
    this.kind = kind;
  }
}

/** Minimum Stellar SDK RPC surface required by the escrow watcher. */
export type EscrowEventRpcServer = Pick<
  rpc.Server,
  "getEvents" | "getLatestLedger"
>;

/** Options for {@link EscrowGateClient.watchEscrow}. */
export interface WatchEscrowOptions {
  /** Injectable Soroban RPC server, primarily for tests or custom transports. */
  server?: EscrowEventRpcServer;
  /** Delay between empty successful polls. Defaults to 4 seconds. */
  pollIntervalMs?: number;
  /** Base delay for transient RPC retries. Defaults to 1 second. */
  retryBaseDelayMs?: number;
  /** Maximum exponential retry delay. Defaults to 30 seconds. */
  retryMaxDelayMs?: number;
  /** Timeout used by the default RPC server. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Number of events requested in each RPC page. Defaults to 100. */
  pageLimit?: number;
}

type ParsedRpcEvent = rpc.Api.EventResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (isRecord(value) && typeof value.message === "string") {
    return value.message;
  }
  return String(value ?? "");
}

function validPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function validateEscrowId(escrowId: bigint): void {
  if (typeof escrowId !== "bigint" || escrowId <= 0n || escrowId > U64_MAX) {
    throw new RangeError("escrowId must be a positive u64 bigint");
  }
}

function validateOptions(options: WatchEscrowOptions): Required<
  Pick<
    WatchEscrowOptions,
    | "pollIntervalMs"
    | "retryBaseDelayMs"
    | "retryMaxDelayMs"
    | "timeoutMs"
    | "pageLimit"
  >
> {
  const values = {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
    retryMaxDelayMs: options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pageLimit: options.pageLimit ?? DEFAULT_PAGE_LIMIT,
  };
  for (const [name, value] of Object.entries(values)) {
    validPositiveInteger(value, name);
  }
  if (values.retryMaxDelayMs < values.retryBaseDelayMs) {
    throw new RangeError("retryMaxDelayMs must be at least retryBaseDelayMs");
  }
  if (values.pageLimit > MAX_PAGE_LIMIT) {
    throw new RangeError(`pageLimit cannot exceed ${MAX_PAGE_LIMIT}`);
  }
  return values;
}

function xdrBase64(value: xdr.ScVal): string {
  return value.toXDR("base64");
}

function buildFilters(contractId: string, escrowId: bigint): rpc.Api.EventFilter[] {
  const idTopic = xdrBase64(nativeToScVal(escrowId, { type: "u64" }));
  const commonNames: EscrowEventName[] = [
    "created",
    "disbursed",
    "refunded",
    "keeper_refund",
    "dispute_resolved",
  ];
  const topic = (name: EscrowEventName) =>
    xdrBase64(nativeToScVal(name, { type: "symbol" }));

  return [
    {
      type: "contract",
      contractIds: [contractId],
      topics: [commonNames.map(topic), [idTopic]],
    },
    {
      type: "contract",
      contractIds: [contractId],
      topics: [[topic("split_disb")], [idTopic], ["*"]],
    },
    {
      type: "contract",
      contractIds: [contractId],
      topics: [[topic("ClawbackHandled")], ["*"]],
    },
  ];
}

function asNative(value: xdr.ScVal): unknown {
  try {
    return scValToNative(value);
  } catch {
    return undefined;
  }
}

function asTuple(value: unknown, expectedLength: number): unknown[] | undefined {
  return Array.isArray(value) && value.length === expectedLength
    ? value
    : undefined;
}

function asBigInt(value: unknown): bigint | undefined {
  return typeof value === "bigint" ? value : undefined;
}

function asNonNegativeBigInt(value: unknown): bigint | undefined {
  const integer = asBigInt(value);
  return integer !== undefined && integer >= 0n ? integer : undefined;
}

function asAddress(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value))
  ) {
    return undefined;
  }
  return value;
}

function asHex32(value: unknown): string | undefined {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    return undefined;
  }
  return Buffer.from(value).toString("hex");
}

function asTopicBigInt(event: ParsedRpcEvent, index: number): bigint | undefined {
  const topic = event.topic[index];
  return topic ? asBigInt(asNative(topic)) : undefined;
}

function asTopicIndex(event: ParsedRpcEvent, index: number): number | undefined {
  const topic = event.topic[index];
  const value = topic ? asNative(topic) : undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (
    typeof value === "bigint" &&
    value >= 0n &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return undefined;
}

function asTopicString(event: ParsedRpcEvent, index: number): string | undefined {
  const topic = event.topic[index];
  const value = topic ? asNative(topic) : undefined;
  return typeof value === "string" ? value : undefined;
}

function validEventMetadata(
  event: ParsedRpcEvent,
  contractId: string
): EscrowEventMetadata | undefined {
  const actualContractId = event.contractId?.toString();
  if (
    event.type !== "contract" ||
    actualContractId !== contractId ||
    !event.id ||
    !event.txHash ||
    !Number.isSafeInteger(event.ledger) ||
    event.ledger <= 0 ||
    !Number.isSafeInteger(event.transactionIndex) ||
    event.transactionIndex < 0 ||
    !Number.isSafeInteger(event.operationIndex) ||
    event.operationIndex < 0 ||
    typeof event.ledgerClosedAt !== "string"
  ) {
    return undefined;
  }
  if (event.inSuccessfulContractCall === false) return undefined;
  return {
    eventId: event.id,
    contractId: actualContractId,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    transactionIndex: event.transactionIndex,
    operationIndex: event.operationIndex,
    txHash: event.txHash,
  };
}

function decodeEvent(
  event: ParsedRpcEvent,
  expectedEscrowId: bigint,
  contractId: string
): EscrowEvent | undefined {
  const metadata = validEventMetadata(event, contractId);
  if (!metadata || !Array.isArray(event.topic) || !event.value) return undefined;

  const name = asTopicString(event, 0);
  if (!name) return undefined;
  const nativeValue = asNative(event.value);

  if (name === "ClawbackHandled") {
    const token = asAddress(asNative(event.topic[1]));
    const tuple = asTuple(nativeValue, 2);
    const escrowId = tuple ? asBigInt(tuple[0]) : undefined;
    const deficit = tuple ? asBigInt(tuple[1]) : undefined;
    if (
      escrowId !== expectedEscrowId ||
      !token ||
      deficit === undefined ||
      deficit < 0n
    ) {
      return undefined;
    }
    return { type: "clawback_handled", escrowId, token, deficit, metadata };
  }

  const escrowId = asTopicBigInt(event, 1);
  if (escrowId !== expectedEscrowId) return undefined;

  if (name === "created") {
    const tuple = asTuple(nativeValue, 3);
    const payer = tuple ? asAddress(tuple[0]) : undefined;
    const amount = tuple ? asNonNegativeBigInt(tuple[1]) : undefined;
    const profileHashHex = tuple ? asHex32(tuple[2]) : undefined;
    if (!payer || amount === undefined || !profileHashHex) return undefined;
    return { type: "created", escrowId, payer, amount, profileHashHex, metadata };
  }

  if (name === "disbursed") {
    const tuple = asTuple(nativeValue, 2);
    const profileHashHex = tuple ? asHex32(tuple[0]) : undefined;
    const amount = tuple ? asNonNegativeBigInt(tuple[1]) : undefined;
    if (!profileHashHex || amount === undefined) return undefined;
    return { type: "disbursed", escrowId, profileHashHex, amount, metadata };
  }

  if (name === "split_disb") {
    const index = asTopicIndex(event, 2);
    const tuple = asTuple(nativeValue, 3);
    const recipient = tuple ? asAddress(tuple[0]) : undefined;
    const amount = tuple ? asNonNegativeBigInt(tuple[1]) : undefined;
    const commitmentHashHex = tuple ? asHex32(tuple[2]) : undefined;
    if (
      index === undefined ||
      !recipient ||
      amount === undefined ||
      !commitmentHashHex
    ) {
      return undefined;
    }
    return {
      type: "split_disb",
      escrowId,
      index,
      recipient,
      amount,
      commitmentHashHex,
      metadata,
    };
  }

  if (name === "refunded") {
    const amount = asNonNegativeBigInt(nativeValue);
    if (amount === undefined) return undefined;
    return { type: "refunded", escrowId, amount, metadata };
  }

  if (name === "keeper_refund") {
    const tuple = asTuple(nativeValue, 4);
    const caller = tuple ? asAddress(tuple[0]) : undefined;
    const bounty = tuple ? asNonNegativeBigInt(tuple[1]) : undefined;
    const payer = tuple ? asAddress(tuple[2]) : undefined;
    const refundAmount = tuple ? asNonNegativeBigInt(tuple[3]) : undefined;
    if (
      !caller ||
      bounty === undefined ||
      !payer ||
      refundAmount === undefined
    ) {
      return undefined;
    }
    return {
      type: "keeper_refund",
      escrowId,
      caller,
      bounty,
      payer,
      refundAmount,
      metadata,
    };
  }

  if (name === "dispute_resolved") {
    const tuple = asTuple(nativeValue, 2);
    const payerAmount = tuple ? asNonNegativeBigInt(tuple[0]) : undefined;
    const beneficiaryAmount = tuple
      ? asNonNegativeBigInt(tuple[1])
      : undefined;
    if (payerAmount === undefined || beneficiaryAmount === undefined) {
      return undefined;
    }
    return {
      type: "dispute_resolved",
      escrowId,
      payerAmount,
      beneficiaryAmount,
      metadata,
    };
  }

  return undefined;
}

function validateResponse(
  response: rpc.Api.GetEventsResponse,
  pageLimit: number,
  rangeStart: number,
  rangeEndExclusive: number
): void {
  if (
    !isRecord(response) ||
    !Array.isArray(response.events) ||
    typeof response.cursor !== "string" ||
    !Number.isSafeInteger(response.latestLedger) ||
    !Number.isSafeInteger(response.oldestLedger) ||
    response.oldestLedger <= 0 ||
    response.latestLedger < response.oldestLedger ||
    typeof response.latestLedgerCloseTime !== "string" ||
    typeof response.oldestLedgerCloseTime !== "string" ||
    response.events.length > pageLimit
  ) {
    throw new EscrowEventStreamError(
      "Soroban RPC returned a malformed getEvents response",
      "invalid_response"
    );
  }
  if (rangeStart < response.oldestLedger) {
    throw new EscrowEventStreamError(
      `Requested ledger ${rangeStart} is older than this RPC node's retained event history (${response.oldestLedger})`,
      "retention_gap"
    );
  }
  for (const event of response.events) {
    if (
      !isRecord(event) ||
      !Number.isSafeInteger(event.ledger) ||
      (event.ledger as number) < rangeStart ||
      (event.ledger as number) >= rangeEndExclusive
    ) {
      throw new EscrowEventStreamError(
        "Soroban RPC returned an event outside the requested ledger range",
        "invalid_response"
      );
    }
  }
}

function errorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.status === "number") return error.status;
  if (isRecord(error.response) && typeof error.response.status === "number") {
    return error.response.status;
  }
  const message = errorMessage(error);
  const match = message.match(/\b(408|425|429|5\d\d)\b/);
  return match ? Number(match[1]) : undefined;
}

function rpcErrorCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.code === "number") return error.code;
  if (isRecord(error.data) && typeof error.data.code === "number") {
    return error.data.code;
  }
  return undefined;
}

function isTransientRpcError(error: unknown): boolean {
  if (error instanceof EscrowEventStreamError) return false;
  const status = errorStatus(error);
  if (status !== undefined) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  const code = rpcErrorCode(error);
  if (code !== undefined) {
    if (code === -32600 || code === -32601 || code === -32602) return false;
    if (code === -32603) return true;
    if (code <= -32000 && code >= -32099) {
      return /busy|connection|internal error|limit exceeded|overload|rate.?limit|server error|temporar|timeout|too many requests|try again|unavailable/i.test(
        errorMessage(error)
      );
    }
    return false;
  }
  const message = errorMessage(error);
  return (
    /fetch failed|failed to fetch|network error|network request failed|timeout|temporar|rate.?limit|service unavailable|connection reset|econn|etimedout|socket hang up/i.test(
      message
    )
  );
}

function isInvalidCursorError(error: unknown): boolean {
  const cause = isRecord(error) ? error.cause : undefined;
  const message = [error, cause]
    .map(errorMessage)
    .join(" ");
  return /cursor.{0,40}(invalid|expired|not found|unknown)|(?:invalid|expired|unknown).{0,40}cursor/i.test(
    message
  );
}

function isLedgerRetentionError(error: unknown): boolean {
  const cause = isRecord(error) ? error.cause : undefined;
  const message = [error, cause]
    .map(errorMessage)
    .join(" ");
  return /startLedger.*(ledger range|retention|oldest)|ledger range.*startLedger/i.test(
    message
  );
}

function abortError(): Error {
  const error = new Error("Escrow event iterator was cancelled");
  error.name = "AbortError";
  return error;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function eventIdentity(event: ParsedRpcEvent): string | undefined {
  if (!event.id || !event.txHash || !Number.isSafeInteger(event.ledger)) {
    return undefined;
  }
  return [
    event.ledger,
    event.txHash,
    event.transactionIndex,
    event.operationIndex,
    event.id,
  ].join(":");
}

async function* iterateEscrowEvents(
  escrowId: bigint,
  config: ClientConfig,
  options: WatchEscrowOptions,
  signal: AbortSignal
): AsyncGenerator<EscrowEvent> {
  const settings = validateOptions(options);
  let server = options.server;
  if (!server) {
    const sdkServer = new rpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
      timeout: settings.timeoutMs,
    });
    const cancellation = new sdkServer.httpClient.CancelToken((cancel) => {
      if (signal.aborted) {
        cancel("Escrow event iterator was cancelled");
        return;
      }
      signal.addEventListener(
        "abort",
        () => cancel("Escrow event iterator was cancelled"),
        { once: true }
      );
    });
    sdkServer.httpClient.defaults.cancelToken = cancellation;
    server = sdkServer;
  }
  const filters = buildFilters(config.contractId, escrowId);
  const seen = new Map<string, number>();
  let lastCompletedLedger: number | undefined;
  let firstRangeStart: number | undefined;
  let failures = 0;

  const backoff = (): number =>
    Math.min(
      settings.retryMaxDelayMs,
      settings.retryBaseDelayMs * 2 ** Math.min(failures - 1, 20)
    );

  const retry = async <T>(request: () => Promise<T>): Promise<T> => {
    while (!signal.aborted) {
      try {
        const result = await withAbort(request(), signal);
        failures = 0;
        return result;
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (!isTransientRpcError(error)) {
          if (error instanceof EscrowEventStreamError) throw error;
          if (isLedgerRetentionError(error)) {
            throw new EscrowEventStreamError(
              "The RPC node no longer retains the requested ledger range; event completeness cannot be guaranteed",
              "retention_gap",
              { cause: error }
            );
          }
          throw new EscrowEventStreamError(
            "Soroban RPC rejected an escrow event request",
            "rpc",
            { cause: error }
          );
        }
        failures += 1;
        await sleep(backoff(), signal);
      }
    }
    throw abortError();
  };

  try {
    while (!signal.aborted) {
      if (lastCompletedLedger === undefined) {
        const latest = await retry(() => server.getLatestLedger());
        if (!Number.isSafeInteger(latest.sequence) || latest.sequence <= 0) {
          throw new EscrowEventStreamError(
            "Soroban RPC returned an invalid latest ledger sequence",
            "invalid_response"
          );
        }
        lastCompletedLedger = latest.sequence;
        firstRangeStart = latest.sequence + 1;
        if (!Number.isSafeInteger(firstRangeStart)) {
          throw new EscrowEventStreamError(
            "Latest ledger sequence exceeds the supported integer range",
            "invalid_response"
          );
        }
        await sleep(settings.pollIntervalMs, signal);
        continue;
      }

      const latest = await retry(() => server.getLatestLedger());
      if (!Number.isSafeInteger(latest.sequence) || latest.sequence <= 0) {
        throw new EscrowEventStreamError(
          "Soroban RPC returned an invalid latest ledger sequence",
          "invalid_response"
        );
      }
      if (latest.sequence <= lastCompletedLedger) {
        await sleep(settings.pollIntervalMs, signal);
        continue;
      }

      const rangeStart =
        firstRangeStart !== undefined
          ? firstRangeStart
          : lastCompletedLedger;
      const rangeEndExclusive = Math.min(
        latest.sequence + 1,
        rangeStart + MAX_LEDGER_WINDOW
      );
      if (
        !Number.isSafeInteger(rangeEndExclusive) ||
        rangeEndExclusive <= rangeStart
      ) {
        throw new EscrowEventStreamError(
          "Soroban RPC ledger range is invalid",
          "invalid_response"
        );
      }

      let cursor: string | undefined;
      let restartCursorOnce = false;
      let completedEnd = rangeEndExclusive - 1;
      let rangeComplete = false;

      while (!rangeComplete && !signal.aborted) {
        let response: rpc.Api.GetEventsResponse;
        try {
          response = await retry(() =>
            server.getEvents(
              cursor
                ? { cursor, filters, limit: settings.pageLimit }
                : {
                    startLedger: rangeStart,
                    endLedger: rangeEndExclusive,
                    filters,
                    limit: settings.pageLimit,
                  }
            )
          );
        } catch (error) {
          if (signal.aborted) throw abortError();
          if (cursor && !restartCursorOnce && isInvalidCursorError(error)) {
            cursor = undefined;
            restartCursorOnce = true;
            continue;
          }
          throw error;
        }

        validateResponse(
          response,
          settings.pageLimit,
          rangeStart,
          rangeEndExclusive
        );
        completedEnd = Math.min(rangeEndExclusive - 1, response.latestLedger);
        if (completedEnd < rangeStart) {
          throw new EscrowEventStreamError(
            "Soroban RPC event response is behind the requested ledger range",
            "rpc"
          );
        }

        for (const rawEvent of response.events) {
          if (signal.aborted) break;
          if (rawEvent.ledger > completedEnd) {
            throw new EscrowEventStreamError(
              "Soroban RPC returned an event beyond its reported latest ledger",
              "invalid_response"
            );
          }
          const identity = eventIdentity(rawEvent);
          if (!identity || seen.has(identity)) continue;
          const event = decodeEvent(rawEvent, escrowId, config.contractId);
          if (!event) continue;
          seen.set(identity, rawEvent.ledger);
          yield event;
        }

        if (response.events.length < settings.pageLimit) {
          rangeComplete = true;
        } else {
          if (!response.cursor || response.cursor === cursor) {
            throw new EscrowEventStreamError(
              "Soroban RPC did not advance its event pagination cursor",
              "invalid_response"
            );
          }
          cursor = response.cursor;
        }
      }

      if (signal.aborted) break;
      if (rangeComplete) {
        lastCompletedLedger = completedEnd;
        firstRangeStart = undefined;
        for (const [identity, ledger] of seen) {
          if (ledger < lastCompletedLedger) seen.delete(identity);
        }
      }

      failures = 0;
      await sleep(settings.pollIntervalMs, signal);
    }
  } catch (error) {
    if (!signal.aborted && !(error instanceof EscrowEventStreamError)) {
      throw new EscrowEventStreamError(
        "Escrow event polling stopped after an unexpected failure",
        "rpc",
        { cause: error }
      );
    }
    if (!signal.aborted) throw error;
  }
}

/**
 * Creates an escrow event iterator for use by {@link EscrowGateClient}.
 *
 * A stream starts at the RPC's latest closed ledger, so it reports subsequent
 * changes and does not replay historical events. RPC queries use bounded
 * 256-ledger windows and opaque pagination cursors. Event identities include
 * ledger, transaction hash, transaction and operation order, and RPC event ID;
 * the in-memory deduplication set retains only the active window and its
 * overlapping boundary ledger.
 *
 * @internal
 */
export function createEscrowEventIterator(
  escrowId: bigint,
  config: ClientConfig,
  options: WatchEscrowOptions = {}
): AsyncIterableIterator<EscrowEvent> {
  validateEscrowId(escrowId);
  validateOptions(options);

  const controller = new AbortController();
  const generator = iterateEscrowEvents(
    escrowId,
    config,
    options,
    controller.signal
  );
  let closed = false;

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next(value?: unknown): Promise<IteratorResult<EscrowEvent>> {
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return generator.next(value as never).then(
        (result) => {
          if (result.done) {
            closed = true;
            controller.abort();
          }
          return result;
        },
        (error: unknown) => {
          closed = true;
          controller.abort();
          throw error;
        }
      );
    },
    async return(value?: unknown): Promise<IteratorResult<EscrowEvent>> {
      if (closed) return { done: true, value };
      closed = true;
      controller.abort();
      return generator.return(value as never);
    },
    async throw(error?: unknown): Promise<IteratorResult<EscrowEvent>> {
      if (closed) throw error;
      closed = true;
      controller.abort();
      return generator.throw(error);
    },
  };
}
