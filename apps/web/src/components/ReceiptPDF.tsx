"use client";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Download, FileText } from "lucide-react";

/**
 * Client-side escrow receipt (invoice) export.
 *
 * The PDF is assembled in the browser without any external renderer so the
 * document works offline and no transaction data leaves the page.
 */

export const RECEIPT_BRAND = "SorobanAnchor Gate";
export const RECEIPT_SUBTITLE = "Escrow Settlement Receipt";
export const RECEIPT_DISCLAIMER =
  "This receipt is generated from onchain escrow data for informational purposes only. " +
  "It is not a financial, tax, or legal document, and it is not an offer or advice. " +
  "SorobanAnchor Gate is not a licensed money transmitter; fiat settlement is executed by " +
  "the counterparty anchor. Verify every detail against the Stellar ledger before relying on it.";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const TOP_Y = PAGE_HEIGHT - 60;
const BOTTOM_Y = 60;

export interface ReceiptTransaction {
  /** Stellar transaction hash of the escrow settlement. */
  transactionHash: string;
  /** ISO timestamp (or Date) of the ledger close. */
  timestamp: string | number | Date;
  /** Payer wallet address. */
  payer: string;
  /** Beneficiary / contractor address. */
  beneficiary: string;
  /** Anchor identifier handling the off-ramp. */
  anchorId: string;
  /** Settled amount as a decimal string, e.g. "1250.0000000". */
  amount: string;
  /** Token symbol, e.g. "USDC". */
  token?: string;
  /** Network fees paid, in the settlement asset. */
  feePaid?: string;
  /** Onchain escrow id, if the receipt covers a single escrow. */
  escrowId?: string;
  /** Stellar network the transaction settled on. */
  network?: string;
}

export function formatReceiptTimestamp(value: ReceiptTransaction["timestamp"]): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export function validateReceipt(transaction: Partial<ReceiptTransaction>): string[] {
  const errors: string[] = [];
  if (!transaction.transactionHash?.trim()) errors.push("transaction hash is required");
  if (!transaction.payer?.trim()) errors.push("payer address is required");
  if (!transaction.beneficiary?.trim()) errors.push("beneficiary address is required");
  if (!transaction.anchorId?.trim()) errors.push("anchor id is required");
  if (!transaction.amount?.trim()) errors.push("amount is required");
  if (!formatReceiptTimestamp(transaction.timestamp ?? "")) {
    errors.push("a valid timestamp is required");
  }
  return errors;
}

export function receiptFileName(transaction: ReceiptTransaction): string {
  const hash = (transaction.transactionHash || "").slice(0, 12) || "escrow";
  return `soroban-anchor-receipt-${hash}.pdf`;
}

/** Wraps text into lines of at most `maxChars` characters. */
export function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

interface PdfLine {
  text: string;
  size: number;
  bold: boolean;
  gapBefore: number;
}

/** Escapes text for a PDF string literal and keeps it 7-bit ASCII. */
function escapePdfText(text: string): string {
  return text
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function receiptLines(transaction: ReceiptTransaction): PdfLine[] {
  const lines: PdfLine[] = [
    { text: RECEIPT_BRAND, size: 20, bold: true, gapBefore: 0 },
    { text: RECEIPT_SUBTITLE, size: 12, bold: false, gapBefore: 6 },
    { text: "-".repeat(62), size: 9, bold: false, gapBefore: 14 },
  ];

  const rows: Array<[string, string]> = [
    ["Transaction hash", transaction.transactionHash],
    ["Settled at", formatReceiptTimestamp(transaction.timestamp)],
    ["Payer", transaction.payer],
    ["Beneficiary", transaction.beneficiary],
    ["Anchor id", transaction.anchorId],
    ["Network", transaction.network ?? "Stellar"],
    ["Asset", transaction.token ?? "XLM"],
    ["Amount", `${transaction.amount} ${transaction.token ?? "XLM"}`.trim()],
  ];

  if (transaction.feePaid) {
    rows.push(["Fees paid", `${transaction.feePaid} ${transaction.token ?? "XLM"}`.trim()]);
  }
  if (transaction.escrowId) {
    rows.push(["Escrow id", transaction.escrowId]);
  }

  for (const [label, value] of rows) {
    lines.push({ text: label.toUpperCase(), size: 8, bold: true, gapBefore: 12 });
    for (const chunk of wrapText(value, 92)) {
      lines.push({ text: chunk, size: 10, bold: false, gapBefore: 2 });
    }
  }

  lines.push({ text: "LEGAL DISCLAIMER", size: 8, bold: true, gapBefore: 26 });
  for (const chunk of wrapText(RECEIPT_DISCLAIMER, 92)) {
    lines.push({ text: chunk, size: 8, bold: false, gapBefore: 2 });
  }

  return lines;
}

/**
 * Builds a single-page PDF receipt. Deterministic for identical input, so it can
 * be asserted in tests.
 */
export function buildReceiptPdf(transaction: ReceiptTransaction): Uint8Array {
  const missing = validateReceipt(transaction);
  if (missing.length > 0) {
    throw new Error(`Cannot build receipt PDF: ${missing.join(", ")}`);
  }

  let content = "";
  let y = TOP_Y;
  for (const line of receiptLines(transaction)) {
    y -= line.gapBefore;
    if (y < BOTTOM_Y) break;
    const font = line.bold ? "/F2" : "/F1";
    content += `BT ${font} ${line.size} Tf ${MARGIN} ${y.toFixed(2)} Td (${escapePdfText(
      line.text
    )}) Tj ET\n`;
    y -= line.size * 1.6;
  }

  const offsets: number[] = [];
  let pdf = "%PDF-1.4\n";

  const addObject = (id: number, body: string) => {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${body}\nendobj\n`;
  };

  addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  addObject(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>"
  );
  addObject(
    4,
    `<< /Length ${content.length} >>\nstream\n${content}endstream`
  );
  addObject(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  addObject(6, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  addObject(
    7,
    `<< /Title (${escapePdfText(`${RECEIPT_BRAND} ${RECEIPT_SUBTITLE}`)}) ` +
      `/Author (${escapePdfText(RECEIPT_BRAND)}) /Producer (${escapePdfText(
        RECEIPT_BRAND
      )}) >>`
  );

  const xrefStart = pdf.length;
  const objectCount = offsets.length; // ids 1..7
  pdf += `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let id = 1; id < objectCount; id++) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objectCount} /Root 1 0 R /Info 7 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) {
    bytes[i] = pdf.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** Triggers a browser download of the receipt PDF. No-op during SSR. */
export function downloadReceiptPdf(
  transaction: ReceiptTransaction,
  filename: string = receiptFileName(transaction)
): void {
  if (typeof window === "undefined") return;
  const bytes = buildReceiptPdf(transaction);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const blob = new Blob([buffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export interface ReceiptPDFProps {
  transaction: ReceiptTransaction;
  className?: string;
}

export function ReceiptPDF({ transaction, className }: ReceiptPDFProps) {
  const missing = validateReceipt(transaction);

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-primary" />
          <CardTitle>{RECEIPT_SUBTITLE}</CardTitle>
        </div>
        <CardDescription>
          Download a PDF invoice with the settlement details and transaction proof.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
          {[
            ["Transaction hash", transaction.transactionHash],
            ["Settled at", formatReceiptTimestamp(transaction.timestamp)],
            ["Payer", transaction.payer],
            ["Beneficiary", transaction.beneficiary],
            ["Anchor id", transaction.anchorId],
            ["Amount", `${transaction.amount} ${transaction.token ?? "XLM"}`.trim()],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-border p-3">
              <dt className="text-muted-foreground uppercase">{label}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {RECEIPT_DISCLAIMER}
        </p>
        <Button
          type="button"
          onClick={() => downloadReceiptPdf(transaction)}
          disabled={missing.length > 0}
          className="text-xs"
        >
          <Download className="w-3 h-3 mr-1" /> Download PDF receipt
        </Button>
      </CardContent>
    </Card>
  );
}
