import assert from "node:assert";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CountdownTimer,
  computeCountdown,
  computeLedgerClockOffset,
  parseLedgerTime,
  useCountdown,
  type CountdownTimeInput,
} from "../components/CountdownTimer";

const TARGET_SECONDS = 1_800_000_000; // 2027-01-15T08:00:00Z
const TARGET_MS = TARGET_SECONDS * 1000;

describe("Countdown timestamp parsing", () => {
  test("treats small numeric inputs as Stellar ledger unix seconds", () => {
    assert.strictEqual(parseLedgerTime(TARGET_SECONDS), TARGET_MS);
  });

  test("keeps large numeric inputs as milliseconds", () => {
    assert.strictEqual(parseLedgerTime(TARGET_MS), TARGET_MS);
  });

  test("accepts numeric strings as ledger seconds", () => {
    assert.strictEqual(parseLedgerTime(String(TARGET_SECONDS)), TARGET_MS);
  });

  test("accepts Date instances", () => {
    assert.strictEqual(parseLedgerTime(new Date(TARGET_MS)), TARGET_MS);
  });

  test("parses ISO timestamps with an explicit Z suffix", () => {
    assert.strictEqual(
      parseLedgerTime("2027-01-15T08:00:00Z"),
      TARGET_MS
    );
  });

  test("interprets timezone-less timestamps as UTC, not local time", () => {
    assert.strictEqual(
      parseLedgerTime("2027-01-15T08:00:00"),
      Date.UTC(2027, 0, 15, 8, 0, 0)
    );
    assert.strictEqual(
      parseLedgerTime("2027-01-15"),
      Date.UTC(2027, 0, 15)
    );
  });

  test("honours explicit timezone offsets", () => {
    assert.strictEqual(
      parseLedgerTime("2027-01-15T10:00:00+02:00"),
      TARGET_MS
    );
    assert.strictEqual(
      parseLedgerTime("2027-01-15T03:00:00-05:00"),
      TARGET_MS
    );
  });

  test("rejects null, undefined, blank, invalid, and non-finite inputs", () => {
    const invalidInputs: CountdownTimeInput[] = [
      null,
      undefined,
      "",
      "   ",
      "not-a-date",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date("invalid"),
    ];
    for (const input of invalidInputs) {
      assert.strictEqual(parseLedgerTime(input), null);
    }
  });
});

describe("Countdown computation", () => {
  test("computes days, hours, minutes and seconds while active", () => {
    const remaining = ((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000;
    const state = computeCountdown(TARGET_SECONDS, TARGET_MS - remaining);

    assert.strictEqual(state.status, "active");
    assert.strictEqual(state.isExpired, false);
    assert.strictEqual(state.remainingMs, remaining);
    assert.strictEqual(state.days, 2);
    assert.strictEqual(state.hours, 3);
    assert.strictEqual(state.minutes, 4);
    assert.strictEqual(state.seconds, 5);
    assert.strictEqual(state.formatted, "2d 03h 04m 05s");
  });

  test("omits the day segment when less than one day remains", () => {
    const state = computeCountdown(
      TARGET_SECONDS,
      TARGET_MS - (61 * 60 + 1) * 1000
    );
    assert.strictEqual(state.days, 0);
    assert.strictEqual(state.formatted, "01h 01m 01s");
  });

  test("rounds a partial final second up so the timer never shows zero early", () => {
    const state = computeCountdown(TARGET_SECONDS, TARGET_MS - 1);
    assert.strictEqual(state.status, "active");
    assert.strictEqual(state.totalSeconds, 1);
    assert.strictEqual(state.seconds, 1);
  });

  test("expires exactly at the target timestamp", () => {
    const state = computeCountdown(TARGET_SECONDS, TARGET_MS);
    assert.strictEqual(state.status, "expired");
    assert.strictEqual(state.isExpired, true);
    assert.strictEqual(state.remainingMs, 0);
    assert.strictEqual(state.totalSeconds, 0);
    assert.strictEqual(state.formatted, "00h 00m 00s");
  });

  test("clamps past timestamps instead of rendering negative values", () => {
    const state = computeCountdown(TARGET_SECONDS, TARGET_MS + 86_400_000);
    assert.strictEqual(state.status, "expired");
    assert.strictEqual(state.remainingMs, 0);
    assert.strictEqual(state.totalSeconds, 0);
    assert.strictEqual(state.days, 0);
    assert.strictEqual(state.hours, 0);
    assert.strictEqual(state.minutes, 0);
    assert.strictEqual(state.seconds, 0);
    assert.ok(!state.formatted.includes("-"));
  });

  test("returns an invalid state for unparseable expirations", () => {
    const state = computeCountdown("not-a-date", TARGET_MS);
    assert.strictEqual(state.status, "invalid");
    assert.strictEqual(state.isExpired, false);
    assert.strictEqual(state.remainingMs, 0);
    assert.strictEqual(state.formatted, "--");
  });

  test("returns an invalid state when the clock sample is not finite", () => {
    const state = computeCountdown(TARGET_SECONDS, Number.NaN);
    assert.strictEqual(state.status, "invalid");
  });
});

describe("Stellar ledger clock synchronisation", () => {
  test("derives a positive offset when the local clock lags the ledger", () => {
    const localNow = TARGET_MS - 5_000;
    assert.strictEqual(computeLedgerClockOffset(TARGET_SECONDS, localNow), 5_000);
  });

  test("derives a negative offset when the local clock leads the ledger", () => {
    const localNow = TARGET_MS + 2_500;
    assert.strictEqual(computeLedgerClockOffset(TARGET_SECONDS, localNow), -2_500);
  });

  test("returns a zero offset for invalid ledger samples", () => {
    assert.strictEqual(computeLedgerClockOffset("nope", TARGET_MS), 0);
    assert.strictEqual(computeLedgerClockOffset(TARGET_SECONDS, Number.NaN), 0);
  });

  test("useCountdown applies the ledger offset during the initial render", () => {
    // Local clock is 10 minutes behind the ledger, so the ledger-corrected
    // countdown should be 10 minutes shorter than a naive Date.now() timer.
    const localNow = TARGET_MS - 3_600_000;
    const ledgerNow = localNow + 600_000;
    const Probe = () => {
      const state = useCountdown(TARGET_SECONDS, {
        now: () => localNow,
        ledgerTime: ledgerNow,
      });
      return React.createElement(
        "span",
        { "data-testid": "probe" },
        state.formatted
      );
    };

    const html = renderToStaticMarkup(React.createElement(Probe));
    assert.ok(html.includes("00h 50m 00s"), html);
  });

  test("useCountdown marks an already-elapsed target as expired on first render", () => {
    const Probe = () => {
      const state = useCountdown(TARGET_SECONDS, {
        now: () => TARGET_MS + 60_000,
      });
      return React.createElement(
        "span",
        { "data-testid": "probe" },
        `${state.status}:${state.remainingMs}`
      );
    };

    const html = renderToStaticMarkup(React.createElement(Probe));
    assert.ok(html.includes("expired:0"), html);
  });
});

describe("CountdownTimer component", () => {
  const now = () => TARGET_MS - 3_661_000; // 01h 01m 01s remaining

  test("renders an active timer with the Claim Refund button disabled", () => {
    const html = renderToStaticMarkup(
      React.createElement(CountdownTimer, {
        expiresAt: TARGET_SECONDS,
        now,
        onClaimRefund: () => undefined,
      })
    );

    assert.ok(html.includes('data-testid="countdown-timer"'));
    assert.ok(html.includes('data-status="active"'));
    assert.ok(html.includes("Refund unlocks in 01h 01m 01s"));
    assert.ok(html.includes('role="timer"'));
    assert.ok(html.includes('data-testid="claim-refund-button"'));
    assert.ok(html.includes('disabled=""'), "Claim Refund must be disabled while active");
  });

  test("enables Claim Refund once the timer reaches zero", () => {
    const html = renderToStaticMarkup(
      React.createElement(CountdownTimer, {
        expiresAt: TARGET_SECONDS,
        now: () => TARGET_MS,
        onClaimRefund: () => undefined,
      })
    );

    assert.ok(html.includes('data-status="expired"'));
    assert.ok(html.includes("Escrow timeout reached"));
    assert.ok(html.includes('data-testid="claim-refund-button"'));
    assert.ok(!html.includes('disabled=""'), "Claim Refund must be enabled at zero");
  });

  test("never renders negative units after the timeout", () => {
    const html = renderToStaticMarkup(
      React.createElement(CountdownTimer, {
        expiresAt: TARGET_SECONDS,
        now: () => TARGET_MS + 9_999_999,
      })
    );

    assert.ok(html.includes('data-status="expired"'));
    for (const unit of ["hours", "minutes", "seconds"]) {
      assert.ok(
        html.includes(`data-testid="countdown-${unit}">00<`),
        `${unit} must render 00 instead of a negative value`
      );
    }
  });

  test("renders a direct claim link when expired and a href is supplied", () => {
    const html = renderToStaticMarkup(
      React.createElement(CountdownTimer, {
        expiresAt: TARGET_SECONDS,
        now: () => TARGET_MS + 1000,
        claimRefundHref: "/manage?escrow=42&action=refund",
      })
    );

    assert.ok(html.includes('data-testid="claim-refund-link"'));
    assert.ok(html.includes('href="/manage?escrow=42&amp;action=refund"'));
    assert.ok(!html.includes('data-testid="claim-refund-button"'));
  });

  test("renders an invalid-timestamp alert and keeps the action disabled", () => {
    const html = renderToStaticMarkup(
      React.createElement(CountdownTimer, {
        expiresAt: "not-a-date",
        now,
        onClaimRefund: () => undefined,
      })
    );

    assert.ok(html.includes('data-status="invalid"'));
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes("Invalid escrow expiration timestamp"));
    assert.ok(html.includes('disabled=""'));
  });

  test("renders day units when the timeout is more than a day away", () => {
    const html = renderToStaticMarkup(
      React.createElement(CountdownTimer, {
        expiresAt: TARGET_SECONDS,
        now: () => TARGET_MS - (2 * 86_400 + 5) * 1000,
      })
    );

    assert.ok(html.includes('data-testid="countdown-days"'));
    assert.ok(html.includes(">02<"));
    assert.ok(html.includes("Refund unlocks in 2d 00h 00m 05s"));
  });
});
