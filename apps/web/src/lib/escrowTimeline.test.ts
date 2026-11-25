import assert from "node:assert";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ESCROW_TIMELINE_STEPS,
  EscrowTimeline,
  getTimelineProgress,
  getTimelineStepState,
  isTerminalEscrowStatus,
  type EscrowTimelineStatus,
  type RelayStatus,
  type TimelineStepId,
} from "../components/EscrowTimeline";

const ALL_STATUSES: EscrowTimelineStatus[] = [
  "Created",
  "Funded",
  "Processing",
  "Disbursed",
  "Completed",
  "Refunded",
  "Disputed",
];

const FUNDED_TX_HASH =
  "9f2c1d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90123456789ab";

function render(
  status: EscrowTimelineStatus,
  props: Partial<React.ComponentProps<typeof EscrowTimeline>> = {}
): string {
  return renderToStaticMarkup(
    React.createElement(EscrowTimeline, { status, ...props })
  );
}

describe("EscrowTimeline step derivation", () => {
  test("exposes the five lifecycle steps in order", () => {
    assert.deepStrictEqual(
      ESCROW_TIMELINE_STEPS.map((step) => step.id),
      ["created", "funded", "processing", "disbursed", "completed"]
    );
    assert.deepStrictEqual(
      ESCROW_TIMELINE_STEPS.map((step) => step.label),
      ["Created", "Funded", "Processing", "Disbursed", "Completed"]
    );
  });

  test("maps each live status to a single active step", () => {
    assert.strictEqual(getTimelineStepState("Created", 0), "active");
    assert.strictEqual(getTimelineStepState("Created", 1), "pending");
    assert.strictEqual(getTimelineStepState("Funded", 0), "complete");
    assert.strictEqual(getTimelineStepState("Funded", 1), "active");
    assert.strictEqual(getTimelineStepState("Processing", 2), "active");
    assert.strictEqual(getTimelineStepState("Disbursed", 3), "active");
  });

  test("marks earlier steps complete and later steps pending", () => {
    assert.deepStrictEqual(
      [0, 1, 2, 3, 4].map((index) => getTimelineStepState("Processing", index)),
      ["complete", "complete", "active", "pending", "pending"]
    );
  });

  test("marks every step complete for a Completed escrow", () => {
    assert.deepStrictEqual(
      [0, 1, 2, 3, 4].map((index) => getTimelineStepState("Completed", index)),
      ["complete", "complete", "complete", "complete", "complete"]
    );
    assert.strictEqual(getTimelineProgress("Completed").activeIndex, null);
    assert.strictEqual(getTimelineProgress("Completed").completed, true);
  });

  test("treats refunded and disputed escrows as terminal branches", () => {
    for (const status of ["Refunded", "Disputed"] as const) {
      const progress = getTimelineProgress(status);
      assert.strictEqual(progress.activeIndex, null);
      assert.strictEqual(progress.completedCount, 1);
      assert.strictEqual(progress.terminal, status);
      assert.strictEqual(progress.completed, true);
      assert.strictEqual(getTimelineStepState(status, 0), "complete");
      assert.strictEqual(getTimelineStepState(status, 1), "pending");
      assert.strictEqual(isTerminalEscrowStatus(status), true);
    }
  });

  test("does not classify live statuses as terminal", () => {
    for (const status of ["Created", "Funded", "Processing", "Disbursed", "Completed"] as const) {
      assert.strictEqual(isTerminalEscrowStatus(status), false);
    }
  });
});

describe("EscrowTimeline rendering across every escrow status", () => {
  for (const status of ALL_STATUSES) {
    test(`renders the ${status} status variant with a stable data attribute`, () => {
      const html = render(status);
      assert.ok(html.includes('data-testid="escrow-timeline"'));
      assert.ok(html.includes(`data-status="${status}"`));
      assert.ok(html.includes('data-testid="escrow-timeline-svg"'));
      assert.ok(html.includes(`Escrow lifecycle: ${status}`));
    });
  }

  test("Created highlights the first step with an animated pulse indicator", () => {
    const html = render("Created");
    assert.ok(html.includes('data-testid="timeline-step-created" data-state="active"'));
    assert.ok(html.includes('data-testid="timeline-pulse-created"'));
    assert.ok(html.includes("animate-pulse"));
    assert.ok(html.includes('data-testid="timeline-step-funded" data-state="pending"'));
  });

  test("Funded shows Created complete and Funded active", () => {
    const html = render("Funded");
    assert.ok(html.includes('data-testid="timeline-step-created" data-state="complete"'));
    assert.ok(html.includes('data-testid="timeline-step-funded" data-state="active"'));
    assert.ok(html.includes('data-testid="timeline-pulse-funded"'));
    assert.ok(!html.includes('data-testid="timeline-pulse-created"'));
  });

  test("Processing highlights the relay settlement step", () => {
    const html = render("Processing", { relayStatus: "pending" });
    assert.ok(html.includes('data-testid="timeline-step-processing" data-state="active"'));
    assert.ok(html.includes('data-testid="timeline-pulse-processing"'));
    assert.ok(html.includes('data-relay-status="pending"'));
    assert.ok(html.includes("Relay settling fiat"));
  });

  test("Disbursed highlights the anchor release step", () => {
    const html = render("Disbursed");
    assert.ok(html.includes('data-testid="timeline-step-disbursed" data-state="active"'));
    assert.ok(html.includes('data-testid="timeline-pulse-disbursed"'));
    assert.ok(html.includes('data-testid="timeline-step-completed" data-state="pending"'));
  });

  test("Completed removes the pulse because no step is active", () => {
    const html = render("Completed");
    assert.ok(!html.includes("timeline-pulse-"));
    for (const step of ESCROW_TIMELINE_STEPS) {
      assert.ok(
        html.includes(`data-testid="timeline-step-${step.id}" data-state="complete"`),
        `${step.id} must be complete`
      );
    }
  });

  test("Refunded renders the refund branch and terminal banner", () => {
    const html = render("Refunded");
    assert.ok(html.includes('data-testid="timeline-terminal"'));
    assert.ok(html.includes('data-terminal="Refunded"'));
    assert.ok(html.includes("Escrow refunded to payer"));
    assert.ok(!html.includes("timeline-pulse-"));
  });

  test("Disputed renders the dispute branch and terminal banner", () => {
    const html = render("Disputed");
    assert.ok(html.includes('data-testid="timeline-terminal"'));
    assert.ok(html.includes('data-terminal="Disputed"'));
    assert.ok(html.includes("Escrow held for dispute resolution"));
    assert.ok(!html.includes("timeline-pulse-"));
  });

  test("renders all relay status labels", () => {
    const labels: Record<RelayStatus, string> = {
      idle: "Relay idle",
      pending: "Relay settling fiat",
      confirmed: "Relay confirmed",
      failed: "Relay failed",
    };
    for (const [relayStatus, label] of Object.entries(labels) as [
      RelayStatus,
      string,
    ][]) {
      const html = render("Processing", { relayStatus });
      assert.ok(html.includes(label));
      assert.ok(html.includes(`data-relay-status="${relayStatus}"`));
    }
  });
});

describe("EscrowTimeline transaction hash links", () => {
  test("links a step transaction hash to Stellar Expert testnet", () => {
    const html = render("Funded", {
      txHashes: { funded: FUNDED_TX_HASH },
    });

    assert.ok(html.includes('data-testid="timeline-tx-link-funded"'));
    assert.ok(
      html.includes(
        `href="https://stellar.expert/explorer/testnet/tx/${FUNDED_TX_HASH}"`
      )
    );
    assert.ok(html.includes('target="_blank"'));
    assert.ok(html.includes('rel="noopener noreferrer"'));
    assert.ok(html.includes("9f2c1d...6789ab"));
  });

  test("supports public network explorer links", () => {
    const html = render("Disbursed", {
      network: "public",
      txHashes: { disbursed: FUNDED_TX_HASH },
    });

    assert.ok(
      html.includes(
        `href="https://stellar.expert/explorer/public/tx/${FUNDED_TX_HASH}"`
      )
    );
  });

  test("trims whitespace around transaction hashes", () => {
    const html = render("Created", {
      txHashes: { created: `  ${FUNDED_TX_HASH}  ` },
    });

    assert.ok(
      html.includes(
        `https://stellar.expert/explorer/testnet/tx/${FUNDED_TX_HASH}"`
      )
    );
  });

  test("shows a placeholder for steps without a transaction hash", () => {
    const html = render("Funded", {
      txHashes: { funded: FUNDED_TX_HASH } as Partial<
        Record<TimelineStepId, string>
      >,
    });

    assert.ok(html.includes('data-testid="timeline-tx-empty-created"'));
    assert.ok(html.includes("No transaction yet"));
    assert.ok(html.includes('data-testid="timeline-tx-link-funded"'));
  });

  test("renders an escrow id and accessible label when provided", () => {
    const html = render("Processing", { escrowId: 42 });
    assert.ok(html.includes(">#42<"));
    assert.ok(html.includes('aria-label="Escrow 42 lifecycle"'));
  });
});
