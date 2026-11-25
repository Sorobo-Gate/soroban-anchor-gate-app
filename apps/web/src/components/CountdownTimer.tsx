"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Escrow expirations are stored on-chain as Stellar ledger close times (UTC
 * unix seconds). Accept the same value in seconds or milliseconds, an ISO
 * string, or a Date so callers can pass either an RPC ledger time or a
 * contract expiration without extra conversion code.
 */
export type CountdownTimeInput = string | number | Date | null | undefined;

export type CountdownStatus = "active" | "expired" | "invalid";

export interface CountdownState {
  status: CountdownStatus;
  /** Time left in milliseconds, clamped to zero so it can never go negative. */
  remainingMs: number;
  totalSeconds: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  isExpired: boolean;
  /** Compact human readable duration, e.g. "2d 03h 04m 05s". */
  formatted: string;
}

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_MINUTE = 60;
/** Values below this are treated as unix seconds, above as milliseconds. */
const MILLISECOND_THRESHOLD = 100_000_000_000;

function readClock(now?: () => number): number {
  return now ? now() : Date.now();
}

const INVALID_COUNTDOWN: CountdownState = {
  status: "invalid",
  remainingMs: 0,
  totalSeconds: 0,
  days: 0,
  hours: 0,
  minutes: 0,
  seconds: 0,
  isExpired: false,
  formatted: "--",
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Parses a ledger/expiry timestamp into epoch milliseconds.
 *
 * ISO strings without an explicit timezone are interpreted as UTC because all
 * Stellar ledger timestamps are UTC. This avoids the browser silently treating
 * a timezone-less timestamp as local time and shifting the countdown by the
 * user's UTC offset.
 */
export function parseLedgerTime(input: CountdownTimeInput): number | null {
  if (input === null || input === undefined) {
    return null;
  }

  if (input instanceof Date) {
    const ms = input.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      return null;
    }
    return Math.abs(input) < MILLISECOND_THRESHOLD ? input * 1000 : input;
  }

  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }

  if (/^-?\d+$/.test(trimmed)) {
    return parseLedgerTime(Number(trimmed));
  }

  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const ms = Date.parse(hasTimezone ? trimmed : `${trimmed}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Computes the countdown for a target timestamp at a given instant. The
 * remaining duration is clamped at zero so a stale interval tick can never
 * render a negative timer.
 */
export function computeCountdown(
  expiresAt: CountdownTimeInput,
  nowMs: number
): CountdownState {
  const targetMs = parseLedgerTime(expiresAt);
  if (targetMs === null || !Number.isFinite(nowMs)) {
    return { ...INVALID_COUNTDOWN };
  }

  const remainingMs = Math.max(0, targetMs - nowMs);
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const days = Math.floor(totalSeconds / SECONDS_PER_DAY);
  const hours = Math.floor((totalSeconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const isExpired = remainingMs === 0;

  const time = `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;

  return {
    status: isExpired ? "expired" : "active",
    remainingMs,
    totalSeconds,
    days,
    hours,
    minutes,
    seconds,
    isExpired,
    formatted: days > 0 ? `${days}d ${time}` : time,
  };
}

/**
 * Derives the offset between a Stellar ledger clock sample and the local clock.
 * Adding this offset to Date.now() keeps the countdown aligned with ledger time
 * even when the user's machine clock is skewed.
 */
export function computeLedgerClockOffset(
  ledgerTime: CountdownTimeInput,
  localNowMs: number
): number {
  const ledgerMs = parseLedgerTime(ledgerTime);
  if (ledgerMs === null || !Number.isFinite(localNowMs)) {
    return 0;
  }
  return ledgerMs - localNowMs;
}

export interface UseCountdownOptions {
  /** Current time provider. Defaults to Date.now; inject a ledger clock for tests. */
  now?: () => number;
  /** Tick interval in milliseconds. Defaults to one second. */
  tickMs?: number;
  /** A recent ledger timestamp used to correct local clock drift. */
  ledgerTime?: CountdownTimeInput;
  /** Invoked once when the countdown transitions to zero. */
  onExpire?: () => void;
}

/**
 * Second-by-second countdown hook. When `ledgerTime` is supplied the hook
 * applies the ledger/local clock offset, so the displayed value tracks Stellar
 * ledger close times rather than a possibly skewed device clock.
 */
export function useCountdown(
  expiresAt: CountdownTimeInput,
  options: UseCountdownOptions = {}
): CountdownState {
  const { now, tickMs = 1000, ledgerTime, onExpire } = options;

  const clockOffset = React.useMemo(() => {
    if (ledgerTime === undefined) {
      return 0;
    }
    return computeLedgerClockOffset(ledgerTime, readClock(now));
  }, [ledgerTime, now]);

  const clock = React.useCallback(
    () => readClock(now) + clockOffset,
    [now, clockOffset]
  );

  const [state, setState] = React.useState<CountdownState>(() =>
    computeCountdown(expiresAt, clock())
  );

  const expiredRef = React.useRef(state.isExpired);
  const onExpireRef = React.useRef(onExpire);

  React.useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  React.useEffect(() => {
    expiredRef.current = false;
  }, [expiresAt]);

  React.useEffect(() => {
    if (typeof window === "undefined" || tickMs <= 0) {
      return;
    }

    const tick = () => {
      const next = computeCountdown(expiresAt, clock());
      setState(next);
      if (next.isExpired && !expiredRef.current) {
        expiredRef.current = true;
        onExpireRef.current?.();
      }
    };

    tick();
    if (expiredRef.current) {
      return;
    }

    const interval = window.setInterval(tick, tickMs);
    return () => window.clearInterval(interval);
  }, [expiresAt, clock, tickMs]);

  return state;
}

export interface CountdownTimerProps {
  /** Contract expiration / refund unlock timestamp. */
  expiresAt: CountdownTimeInput;
  /** Latest observed Stellar ledger time, used for drift correction. */
  ledgerTime?: CountdownTimeInput;
  /** Override the clock source (useful for tests and ledger time polling). */
  now?: () => number;
  /** Enables the "Claim Refund" action once the timer reaches zero. */
  onClaimRefund?: () => void;
  /** Optional direct link used instead of the callback. */
  claimRefundHref?: string;
  title?: string;
  className?: string;
}

function TimerUnit({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span
        className="font-mono text-2xl font-bold tabular-nums text-foreground"
        data-testid={`countdown-${label.toLowerCase()}`}
      >
        {pad(value)}
      </span>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

export function CountdownTimer({
  expiresAt,
  ledgerTime,
  now,
  onClaimRefund,
  claimRefundHref,
  title = "Refund Unlock Countdown",
  className = "",
}: CountdownTimerProps) {
  const countdown = useCountdown(expiresAt, { ledgerTime, now });
  const canClaim = countdown.isExpired && Boolean(onClaimRefund || claimRefundHref);

  return (
    <section
      className={`rounded-2xl border border-border bg-card p-5 shadow-sm ${className}`}
      data-testid="countdown-timer"
      data-status={countdown.status}
      aria-label={title}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="rounded-lg border border-primary/20 bg-primary/10 p-2 text-primary">
            {countdown.isExpired ? (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            ) : countdown.status === "invalid" ? (
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Clock className="h-4 w-4" aria-hidden="true" />
            )}
          </span>
          <div>
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="text-xs text-muted-foreground">
              Payer refund unlocks when this escrow timeout expires.
            </p>
          </div>
        </div>
      </div>

      {countdown.status === "invalid" ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          Invalid escrow expiration timestamp. Refund eligibility cannot be
          determined until the escrow state is refreshed.
        </p>
      ) : (
        <>
          <div
            role="timer"
            aria-live="off"
            aria-label={countdown.isExpired ? "Escrow timeout elapsed" : `Time remaining: ${countdown.formatted}`}
            className="mt-4 flex items-center justify-center gap-4 rounded-xl border border-border bg-input/40 px-4 py-3"
          >
            {countdown.days > 0 && (
              <TimerUnit label="Days" value={countdown.days} />
            )}
            <TimerUnit label="Hours" value={countdown.hours} />
            <span className="font-mono text-xl text-muted-foreground" aria-hidden="true">
              :
            </span>
            <TimerUnit label="Minutes" value={countdown.minutes} />
            <span className="font-mono text-xl text-muted-foreground" aria-hidden="true">
              :
            </span>
            <TimerUnit label="Seconds" value={countdown.seconds} />
          </div>

          <p
            className={`mt-3 text-xs ${countdown.isExpired ? "text-primary" : "text-muted-foreground"}`}
            data-testid="countdown-status-text"
          >
            {countdown.isExpired
              ? "Escrow timeout reached — the payer can now claim a refund."
              : `Refund unlocks in ${countdown.formatted}.`}
          </p>
        </>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          Timezone: UTC (Stellar ledger)
        </span>
        {claimRefundHref && canClaim ? (
          <a
            href={claimRefundHref}
            className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            data-testid="claim-refund-link"
          >
            Claim Refund
          </a>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={onClaimRefund}
            disabled={!canClaim}
            data-testid="claim-refund-button"
          >
            Claim Refund
          </Button>
        )}
      </div>
    </section>
  );
}
