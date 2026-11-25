import assert from "node:assert";
import { describe, test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import axe from "axe-core";

import {
  getFocusableElements,
  handleHorizontalButtonKeyDown,
  trapDialogFocus,
} from "./a11y";
import { DesktopNav, MobileNav } from "../components/MobileNav";
import { EscrowTable, type EscrowRow } from "../components/EscrowTable";
import { DisputeSlider } from "../components/DisputeSlider";
import { EvidenceUpload } from "../components/EvidenceUpload";
import { EscrowWizard } from "../components/wizard/EscrowWizard";
import { SimulationModal, explainSimulationError } from "../components/SimulationModal";
import { NetworkMismatchModal } from "../components/WalletProvider";
import { CountdownTimer } from "../components/CountdownTimer";
import { EscrowTimeline } from "../components/EscrowTimeline";
import { PaymentQR } from "../components/PaymentQR";

async function runAxeAudit(markup: string, label: string): Promise<void> {
  const dom = new JSDOM(`<!DOCTYPE html><html lang="en"><head><title>${label}</title></head><body>${markup}</body></html>`);
  const { window } = dom;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;

  Object.assign(globalThis, { window, document: window.document });
  try {
    const results = await axe.run(window.document.documentElement, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
      rules: {
        // jsdom does not implement HTMLCanvasElement layout/contrast rendering.
        "color-contrast": { enabled: false },
      },
    });
    assert.deepStrictEqual(
      results.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.html) })),
      [],
      `Expected zero axe-core violations for ${label}`
    );
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
    dom.window.close();
  }
}

const SAMPLE_ROWS: EscrowRow[] = [
  {
    id: "ESC-1",
    recipient: "GAAAAA1111111111111111111111111111111111111111111111111111",
    token: "XLM",
    amount: 250,
    status: "Funded",
    createdAt: "2026-11-20T10:00:00Z",
  },
];

describe("a11y keyboard & focus-trap helpers", () => {
  test("getFocusableElements excludes disabled, inert, and aria-hidden descendants", () => {
    const dom = new JSDOM(`
      <div id="root">
        <button id="b1">First</button>
        <button id="b2" disabled>Disabled</button>
        <a id="a1" href="/create">Create</a>
        <button id="b3" aria-hidden="true">Hidden</button>
        <button id="b4" inert>Inert</button>
        <input id="i1" type="text" />
      </div>
    `);
    const root = dom.window.document.getElementById("root");
    const items = getFocusableElements(root as unknown as HTMLElement);
    assert.deepStrictEqual(
      items.map((el) => el.id),
      ["b1", "a1", "i1"]
    );
    dom.window.close();
  });

  test("trapDialogFocus cycles Tab and Shift+Tab within modal container", () => {
    const dom = new JSDOM(`
      <div id="modal">
        <button id="first">First</button>
        <button id="last">Last</button>
      </div>
    `);
    const { document } = dom.window;
    Object.assign(globalThis, { document });
    try {
      const modal = document.getElementById("modal") as unknown as HTMLElement;
      const first = document.getElementById("first") as unknown as HTMLButtonElement;
      const last = document.getElementById("last") as unknown as HTMLButtonElement;

      let focusedId = "";
      first.focus = () => { focusedId = "first"; };
      last.focus = () => { focusedId = "last"; };

      // Wrap forward from last -> first
      Object.defineProperty(document, "activeElement", { configurable: true, get: () => last });
      let prevented = false;
      trapDialogFocus(modal, { key: "Tab", shiftKey: false, preventDefault: () => { prevented = true; } } as unknown as KeyboardEvent);
      assert.strictEqual(prevented, true);
      assert.strictEqual(focusedId, "first");

      // Wrap backward from first -> last
      Object.defineProperty(document, "activeElement", { configurable: true, get: () => first });
      prevented = false;
      trapDialogFocus(modal, { key: "Tab", shiftKey: true, preventDefault: () => { prevented = true; } } as unknown as KeyboardEvent);
      assert.strictEqual(prevented, true);
      assert.strictEqual(focusedId, "last");
    } finally {
      dom.window.close();
    }
  });

  test("handleHorizontalButtonKeyDown supports ArrowRight, ArrowLeft, Home, and End", () => {
    const items = ["release", "refund", "dispute"] as const;
    const selected: string[] = [];
    const focused: number[] = [];
    const fakeButtons = [0, 1, 2].map((i) => ({ focus: () => focused.push(i) }));
    const parentElement = { querySelectorAll: () => fakeButtons };

    const fire = (key: string, current: (typeof items)[number]) => {
      let prevented = false;
      handleHorizontalButtonKeyDown(
        {
          key,
          preventDefault: () => { prevented = true; },
          currentTarget: { parentElement },
        } as unknown as React.KeyboardEvent<HTMLElement>,
        items,
        current,
        (val) => selected.push(val)
      );
      return prevented;
    };

    assert.strictEqual(fire("ArrowRight", "dispute"), true);
    assert.strictEqual(fire("ArrowLeft", "release"), true);
    assert.strictEqual(fire("End", "release"), true);
    assert.strictEqual(fire("Home", "dispute"), true);
    assert.strictEqual(fire("Enter", "release"), false);

    assert.deepStrictEqual(selected, ["release", "dispute", "dispute", "release"]);
    assert.deepStrictEqual(focused, [0, 2, 2, 0]);
  });
});

describe("WCAG 2.1 AA ARIA markup & axe-core verification", () => {
  test("DesktopNav and MobileNav render accessible navigation landmarks with zero axe violations", async () => {
    const html = renderToStaticMarkup(
      React.createElement(
        "div",
        null,
        React.createElement(
          "header",
          null,
          React.createElement(MobileNav, { pathname: "/create" }),
          React.createElement(DesktopNav, { pathname: "/create" })
        ),
        React.createElement("main", { id: "main-content" }, React.createElement("h1", null, "Create Escrow"))
      )
    );
    assert.ok(html.includes('aria-label="Primary"'));
    assert.ok(html.includes('aria-current="page"'));
    await runAxeAudit(html, "Navigation landmarks");
  });

  test("EscrowTable renders semantic table headers, aria-sort, labels, and zero axe violations", async () => {
    const html = renderToStaticMarkup(
      React.createElement(
        "main",
        null,
        React.createElement("h1", null, "Escrows"),
        React.createElement(EscrowTable, { data: SAMPLE_ROWS })
      )
    );
    assert.ok(html.includes("<thead"));
    assert.ok(html.includes('scope="col"'));
    assert.ok(html.includes('aria-sort="descending"'));
    assert.ok(html.includes('aria-label="Search escrows by ID, recipient, or token"'));
    assert.ok(html.includes('for="escrow-date-from"'));
    assert.ok(html.includes('for="escrow-date-to"'));
    assert.ok(html.includes('for="escrow-page-size"'));
    await runAxeAudit(html, "EscrowTable");
  });

  test("DisputeSlider, EvidenceUpload, and EscrowWizard pass axe-core with zero violations", async () => {
    const html = renderToStaticMarkup(
      React.createElement(
        "main",
        null,
        React.createElement("h1", null, "Disputes & Wizard"),
        React.createElement(DisputeSlider, { payerBps: 6000, onChange: () => undefined }),
        React.createElement(EvidenceUpload, {}),
        React.createElement(EscrowWizard, {
          walletAddress: "",
          tokens: [{ label: "XLM", address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" }],
          fetchBalance: async () => null,
          simulate: async () => "ok",
          onSubmit: async () => undefined,
          busy: false,
          statusMessage: null,
        })
      )
    );
    assert.ok(html.includes('aria-valuetext="60% payer, 40% beneficiary"'));
    assert.ok(html.includes('aria-pressed="true"'));
    assert.ok(html.includes('aria-current="step"'));
    await runAxeAudit(html, "DisputeSlider + EvidenceUpload + EscrowWizard");
  });

  test("SimulationModal, NetworkMismatchModal, CountdownTimer, EscrowTimeline, and PaymentQR pass axe-core", async () => {
    const html = renderToStaticMarkup(
      React.createElement(
        "main",
        null,
        React.createElement("h1", null, "Modals & Status Widgets"),
        React.createElement(CountdownTimer, {
          expiresAt: Date.now() + 3600_000,
          now: () => Date.now(),
        }),
        React.createElement(EscrowTimeline, {
          status: "Funded",
          escrowId: 1,
        }),
        React.createElement(PaymentQR, {
          destination: "GAAAAA1111111111111111111111111111111111111111111111111111",
          amount: "100",
        }),
        React.createElement(SimulationModal, {
          open: true,
          state: { phase: "reverted", error: explainSimulationError("Error(Contract, #3)") },
          actionLabel: "release",
          onConfirm: () => undefined,
          onCancel: () => undefined,
        }),
        React.createElement(NetworkMismatchModal, {
          expectedNetworkPassphrase: "Test SDF Network ; September 2015",
          detectedNetworkPassphrase: "Public Global Stellar Network ; September 2015",
          onRetry: () => undefined,
          onDismiss: () => undefined,
        })
      )
    );
    await runAxeAudit(html, "Modals and widgets");
  });
});
