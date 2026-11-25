import assert from "node:assert";
import { describe, test } from "node:test";
import {
  RECEIPT_BRAND,
  RECEIPT_DISCLAIMER,
  buildReceiptPdf,
  formatReceiptTimestamp,
  receiptFileName,
  validateReceipt,
  wrapText,
  type ReceiptTransaction,
} from "../components/ReceiptPDF";

const MOCK: ReceiptTransaction = {
  transactionHash:
    "9f2c1b7d4e6a8c0d2f4b6a8c0e2d4f6a8b0c2e4d6f8a0b2c4d6e8f0a2b4c6d8e",
  timestamp: "2026-11-20T10:15:00.000Z",
  payer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  beneficiary: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  anchorId: "anchor-ngn-001",
  amount: "1250.0000000",
  token: "USDC",
  feePaid: "0.0001000",
  escrowId: "42",
  network: "Stellar Testnet",
};

function pdfText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

describe("ReceiptPDF document structure", () => {
  test("emits a well-formed single-page PDF", () => {
    const text = pdfText(buildReceiptPdf(MOCK));
    assert.ok(text.startsWith("%PDF-1.4"));
    assert.ok(text.trimEnd().endsWith("%%EOF"));
    assert.ok(text.includes("/Count 1"));
    assert.ok(text.includes("/MediaBox"));
  });

  test("every xref offset points at its object", () => {
    const text = pdfText(buildReceiptPdf(MOCK));
    const xrefStart = text.lastIndexOf("xref\n0 ");
    assert.ok(xrefStart > 0);

    const header = text.slice(xrefStart).split("\n");
    const count = Number(header[1].split(" ")[1]);
    assert.strictEqual(count, 8);

    for (let id = 1; id < count; id++) {
      const entry = header[1 + id];
      const offset = Number(entry.slice(0, 10));
      assert.ok(
        text.startsWith(`${id} 0 obj`, offset),
        `xref entry ${id} does not point at object ${id}`
      );
    }
  });

  test("records the content length matching the stream body", () => {
    const text = pdfText(buildReceiptPdf(MOCK));
    const declared = Number(/\/Length (\d+)/.exec(text)?.[1]);
    const body = text.slice(text.indexOf("stream\n") + "stream\n".length, text.indexOf("endstream"));
    assert.strictEqual(declared, body.length);
  });
});

describe("ReceiptPDF content", () => {
  test("includes branding, settlement details, and the transaction proof", () => {
    const text = pdfText(buildReceiptPdf(MOCK));
    assert.ok(text.includes(RECEIPT_BRAND));
    assert.ok(text.includes("Escrow Settlement Receipt"));
    assert.ok(text.includes(MOCK.transactionHash));
    assert.ok(text.includes(MOCK.payer));
    assert.ok(text.includes(MOCK.beneficiary));
    assert.ok(text.includes(MOCK.anchorId));
    assert.ok(text.includes("1250.0000000 USDC"));
    assert.ok(text.includes("2026-11-20 10:15:00 UTC"));
    assert.ok(text.includes("anchor-ngn-001"));
  });

  test("includes the legal disclaimer", () => {
    const text = pdfText(buildReceiptPdf(MOCK));
    assert.ok(text.includes("LEGAL DISCLAIMER"));
    assert.ok(text.includes("not a licensed money transmitter"));
    assert.ok(text.includes(RECEIPT_DISCLAIMER.slice(0, 40)));
  });

  test("omits optional rows that were not provided", () => {
    const text = pdfText(
      buildReceiptPdf({ ...MOCK, feePaid: undefined, escrowId: undefined, network: undefined })
    );
    assert.ok(!text.includes("FEES PAID"));
    assert.ok(!text.includes("ESCROW ID"));
  });

  test("escapes parentheses and strips non-ASCII characters", () => {
    const text = pdfText(buildReceiptPdf({ ...MOCK, anchorId: "(G)ABC\\", payer: "Ünicode" }));
    assert.ok(text.includes("\\(G\\)ABC\\\\"));
    assert.ok(text.includes("?nicode"));
  });
});

describe("ReceiptPDF validation", () => {
  test("accepts a complete transaction", () => {
    assert.deepStrictEqual(validateReceipt(MOCK), []);
  });

  test("reports every missing required field", () => {
    const errors = validateReceipt({});
    assert.strictEqual(errors.length, 6);
    assert.ok(errors.some((error) => error.includes("transaction hash")));
    assert.ok(errors.some((error) => error.includes("timestamp")));
  });

  test("rejects a receipt with an unparseable timestamp", () => {
    assert.ok(
      validateReceipt({ ...MOCK, timestamp: "not-a-date" }).some((error) =>
        error.includes("timestamp")
      )
    );
    assert.strictEqual(formatReceiptTimestamp("not-a-date"), "");
  });

  test("throws instead of producing a corrupt document", () => {
    assert.throws(
      () => buildReceiptPdf({ ...MOCK, transactionHash: "" }),
      /Cannot build receipt PDF/
    );
  });
});

describe("ReceiptPDF helpers", () => {
  test("derives a filename from the transaction hash", () => {
    assert.strictEqual(
      receiptFileName(MOCK),
      "soroban-anchor-receipt-9f2c1b7d4e6a.pdf"
    );
    assert.strictEqual(receiptFileName({ ...MOCK, transactionHash: "" }), "soroban-anchor-receipt-escrow.pdf");
  });

  test("wraps long text on word boundaries", () => {
    const lines = wrapText("one two three four five", 9);
    assert.deepStrictEqual(lines, ["one two", "three", "four five"]);
    assert.deepStrictEqual(wrapText("", 10), []);
  });

  test("formats timestamps as UTC strings", () => {
    assert.strictEqual(
      formatReceiptTimestamp(new Date("2026-01-02T03:04:05.678Z")),
      "2026-01-02 03:04:05 UTC"
    );
  });
});
