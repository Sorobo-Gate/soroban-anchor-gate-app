import assert from "node:assert";
import { describe, test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import jsQR from "jsqr";
import { Account, Keypair, Networks, Operation, Asset, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  buildSep7PayUri,
  buildSep7TxUri,
  buildPaymentQrModel,
  parseSep7Uri,
  normalizeAmount,
  validateDestination,
  memoHashHexToBase64,
  memoHashBase64ToHex,
  selectErrorCorrectionLevel,
  truncateMiddle,
  copyToClipboard,
  PaymentQR,
  MAX_QR_PAYLOAD_LENGTH,
  SEP7_MAX_MESSAGE_LENGTH,
  type QrErrorCorrectionLevel,
} from "../components/PaymentQR";

const DEST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const MEMO_HEX = "a3f1c2e4b5d6978812345678909abcdeffedcba0987654321fedcba987654321";

/**
 * Decodes a QR code produced by qrcode.react: parses the module runs out of the SVG
 * path, rasterises them to RGBA with a quiet zone, and scans with jsQR. This is a real
 * end-to-end accuracy check — what a phone camera would read back.
 */
function decodeQrSvg(markup: string): string | null {
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(markup);
  assert.ok(viewBox, "SVG must declare a viewBox");
  const modules = Number(viewBox[1]);
  const paths = [...markup.matchAll(/<path[^>]*d="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.length >= 2, "expected background + foreground paths");
  const fg = paths[paths.length - 1];

  const grid: boolean[][] = Array.from({ length: modules }, () => Array(modules).fill(false));
  for (const run of fg.matchAll(/M(\d+)[ ,](\d+) ?h(\d+)v1H\d+z/g)) {
    const x = Number(run[1]);
    const y = Number(run[2]);
    const len = Number(run[3]);
    for (let i = 0; i < len; i++) grid[y][x + i] = true;
  }

  const scale = 6;
  const quiet = 4;
  const size = (modules + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (!grid[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (x + quiet) * scale + dx;
          const py = (y + quiet) * scale + dy;
          const idx = (py * size + px) * 4;
          rgba[idx] = rgba[idx + 1] = rgba[idx + 2] = 0;
        }
      }
    }
  }
  return jsQR(rgba, size, size)?.data ?? null;
}

function renderQr(value: string, level: QrErrorCorrectionLevel = "M"): string {
  return renderToStaticMarkup(React.createElement(QRCodeSVG, { value, level, marginSize: 0 }));
}

function buildTestEnvelope(): string {
  const source = new Account(Keypair.random().publicKey(), "100");
  return new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: DEST, asset: Asset.native(), amount: "10" }))
    .setTimeout(300)
    .build()
    .toXDR();
}

describe("normalizeAmount", () => {
  test("canonicalises leading/trailing zeros", () => {
    assert.strictEqual(normalizeAmount("0010.5000"), "10.5");
    assert.strictEqual(normalizeAmount("100.0"), "100");
    assert.strictEqual(normalizeAmount(" 0.0000001 "), "0.0000001");
  });

  test("accepts the maximum int64 stroop amount", () => {
    assert.strictEqual(normalizeAmount("922337203685.4775807"), "922337203685.4775807");
  });

  test("rejects zero, negatives, exponents, and junk", () => {
    for (const bad of ["0", "0.0000000", "-1", "1e5", "abc", "", "1.", ".5", "1,000", "Infinity"]) {
      assert.throws(() => normalizeAmount(bad), Error, `expected "${bad}" to be rejected`);
    }
  });

  test("rejects more than 7 decimals", () => {
    assert.throws(() => normalizeAmount("1.00000001"), /at most 7 decimal/);
  });

  test("rejects values above int64 stroops", () => {
    assert.throws(() => normalizeAmount("922337203685.4775808"), /maximum/);
  });
});

describe("validateDestination", () => {
  test("accepts G accounts and trims whitespace", () => {
    assert.strictEqual(validateDestination(`  ${DEST} `), DEST);
  });

  test("rejects contract addresses, secrets, and truncated keys", () => {
    assert.throws(() => validateDestination("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"));
    assert.throws(() => validateDestination(Keypair.random().secret()));
    assert.throws(() => validateDestination(DEST.slice(0, 40)));
    assert.throws(() => validateDestination(""), /required/);
  });
});

describe("memo hash encoding", () => {
  test("hex → base64 → hex round-trips", () => {
    const b64 = memoHashHexToBase64(MEMO_HEX);
    assert.strictEqual(memoHashBase64ToHex(b64), MEMO_HEX);
    assert.strictEqual(b64, Buffer.from(MEMO_HEX, "hex").toString("base64"));
  });

  test("accepts 0x prefix and uppercase", () => {
    assert.strictEqual(memoHashHexToBase64(`0x${MEMO_HEX.toUpperCase()}`), memoHashHexToBase64(MEMO_HEX));
  });

  test("rejects wrong lengths and non-hex", () => {
    assert.throws(() => memoHashHexToBase64(MEMO_HEX.slice(2)), /32 bytes/);
    assert.throws(() => memoHashHexToBase64(`${MEMO_HEX}00`), /32 bytes/);
    assert.throws(() => memoHashHexToBase64("z".repeat(64)), /32 bytes/);
    assert.throws(() => memoHashBase64ToHex(Buffer.alloc(16).toString("base64")), /32 bytes/);
  });
});

describe("buildSep7PayUri", () => {
  test("encodes destination, amount, memo hash and testnet passphrase", () => {
    const uri = buildSep7PayUri({
      destination: DEST,
      amount: "125.50",
      memoHashHex: MEMO_HEX,
      networkPassphrase: Networks.TESTNET,
    });
    assert.ok(uri.startsWith("web+stellar:pay?"));
    const { operation, params } = parseSep7Uri(uri);
    assert.strictEqual(operation, "pay");
    assert.strictEqual(params.destination, DEST);
    assert.strictEqual(params.amount, "125.5");
    assert.strictEqual(params.memo_type, "MEMO_HASH");
    assert.strictEqual(memoHashBase64ToHex(params.memo), MEMO_HEX);
    assert.strictEqual(params.network_passphrase, Networks.TESTNET);
    assert.strictEqual(params.asset_code, undefined, "native payments omit asset_code");
  });

  test("percent-encodes reserved characters (base64 '+', '/', '=' and spaces)", () => {
    const uri = buildSep7PayUri({ destination: DEST, amount: "1", memoHashHex: "f".repeat(64), message: "Escrow #42 & fees" });
    const query = uri.split("?")[1];
    assert.ok(!/[ +/]/.test(query.replace(/%[0-9A-F]{2}/g, "")), `unencoded reserved char in ${query}`);
    assert.strictEqual(parseSep7Uri(uri).params.msg, "Escrow #42 & fees");
  });

  test("omits network_passphrase on the public network (SEP-0007 default)", () => {
    const uri = buildSep7PayUri({ destination: DEST, amount: "1", networkPassphrase: Networks.PUBLIC });
    assert.strictEqual(parseSep7Uri(uri).params.network_passphrase, undefined);
  });

  test("includes asset code + issuer for credit assets", () => {
    const { params } = parseSep7Uri(buildSep7PayUri({ destination: DEST, amount: "5", assetCode: "USDC", assetIssuer: ISSUER }));
    assert.strictEqual(params.asset_code, "USDC");
    assert.strictEqual(params.asset_issuer, ISSUER);
  });

  test("rejects credit assets without a valid issuer and XLM with an issuer", () => {
    assert.throws(() => buildSep7PayUri({ destination: DEST, amount: "5", assetCode: "USDC" }), /issuer/);
    assert.throws(() => buildSep7PayUri({ destination: DEST, amount: "5", assetCode: "USDC", assetIssuer: "GBAD" }), /issuer/);
    assert.throws(() => buildSep7PayUri({ destination: DEST, amount: "5", assetCode: "TOOLONGASSETCODE", assetIssuer: ISSUER }), /asset code/);
  });

  test("enforces the 300-character message limit", () => {
    assert.doesNotThrow(() => buildSep7PayUri({ destination: DEST, amount: "1", message: "x".repeat(SEP7_MAX_MESSAGE_LENGTH) }));
    assert.throws(() => buildSep7PayUri({ destination: DEST, amount: "1", message: "x".repeat(SEP7_MAX_MESSAGE_LENGTH + 1) }), /300/);
  });
});

describe("buildSep7TxUri", () => {
  test("wraps a valid envelope and round-trips the XDR exactly", () => {
    const xdr = buildTestEnvelope();
    const uri = buildSep7TxUri({ xdr, networkPassphrase: Networks.TESTNET, message: "Fund escrow" });
    const { operation, params } = parseSep7Uri(uri);
    assert.strictEqual(operation, "tx");
    assert.strictEqual(params.xdr, xdr);
    assert.strictEqual(params.network_passphrase, Networks.TESTNET);
    assert.strictEqual(params.msg, "Fund escrow");
  });

  test("rejects empty or corrupted XDR", () => {
    assert.throws(() => buildSep7TxUri({ xdr: "" }), /required/);
    assert.throws(() => buildSep7TxUri({ xdr: "AAAA-not-xdr" }), /valid base64 transaction envelope/);
  });
});

describe("parseSep7Uri", () => {
  test("rejects foreign schemes and unknown operations", () => {
    assert.throws(() => parseSep7Uri("https://example.com"), /SEP-0007/);
    assert.throws(() => parseSep7Uri("web+stellar:sign?x=1"), /Unsupported/);
  });
});

describe("buildPaymentQrModel", () => {
  test("returns a pay model with display fields", () => {
    const model = buildPaymentQrModel({ destination: DEST, amount: "42.10", memoHashHex: MEMO_HEX.toUpperCase() });
    assert.ok(model.ok);
    assert.strictEqual(model.operation, "pay");
    assert.strictEqual(model.amount, "42.1");
    assert.strictEqual(model.assetLabel, "XLM");
    assert.strictEqual(model.memoHashHex, MEMO_HEX);
    assert.strictEqual(model.level, "M");
  });

  test("switches to tx mode when xdr is provided", () => {
    const model = buildPaymentQrModel({ destination: DEST, amount: "10", xdr: buildTestEnvelope(), networkPassphrase: Networks.TESTNET });
    assert.ok(model.ok);
    assert.strictEqual(model.operation, "tx");
    assert.strictEqual(model.level, selectErrorCorrectionLevel(model.uri.length));
  });

  test("tx mode accepts an escrow contract (C...) as display destination and an issuer-less asset code", () => {
    const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const model = buildPaymentQrModel({
      destination: contractId,
      amount: "10",
      assetCode: "USDC",
      memoHashHex: MEMO_HEX,
      xdr: buildTestEnvelope(),
      networkPassphrase: Networks.TESTNET,
    });
    assert.ok(model.ok);
    assert.strictEqual(model.destination, contractId);
    assert.strictEqual(model.assetLabel, "USDC");
    // ...but pay mode still refuses contracts, since SEP-0007 pay targets accounts.
    assert.strictEqual(buildPaymentQrModel({ destination: contractId, amount: "10" }).ok, false);
  });

  test("uses error-correction L for long multi-operation envelopes", () => {
    const source = new Account(Keypair.random().publicKey(), "1");
    const builder = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET });
    for (let i = 0; i < 8; i++) {
      builder.addOperation(Operation.payment({ destination: DEST, asset: Asset.native(), amount: "1" }));
    }
    const model = buildPaymentQrModel({ destination: DEST, amount: "1", xdr: builder.setTimeout(300).build().toXDR(), networkPassphrase: Networks.TESTNET });
    assert.ok(model.ok);
    assert.ok(model.uri.length > 600);
    assert.strictEqual(model.level, "L");
  });

  test("returns errors as data instead of throwing", () => {
    const model = buildPaymentQrModel({ destination: "bogus", amount: "10" });
    assert.strictEqual(model.ok, false);
    if (!model.ok) assert.match(model.error, /Invalid destination/);
    const badMemo = buildPaymentQrModel({ destination: DEST, amount: "10", memoHashHex: "abc" });
    assert.strictEqual(badMemo.ok, false);
  });

  test("refuses payloads too large to scan", () => {
    const source = new Account(Keypair.random().publicKey(), "1");
    const builder = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET });
    for (let i = 0; i < 40; i++) {
      builder.addOperation(Operation.payment({ destination: DEST, asset: Asset.native(), amount: "1" }));
    }
    const xdr = builder.setTimeout(300).build().toXDR();
    const model = buildPaymentQrModel({ destination: DEST, amount: "1", xdr, networkPassphrase: Networks.TESTNET });
    assert.strictEqual(model.ok, false);
    if (!model.ok) assert.match(model.error, new RegExp(String(MAX_QR_PAYLOAD_LENGTH)));
  });
});

describe("helpers", () => {
  test("selectErrorCorrectionLevel", () => {
    assert.strictEqual(selectErrorCorrectionLevel(100), "M");
    assert.strictEqual(selectErrorCorrectionLevel(600), "M");
    assert.strictEqual(selectErrorCorrectionLevel(601), "L");
  });

  test("truncateMiddle", () => {
    assert.strictEqual(truncateMiddle(DEST), `${DEST.slice(0, 6)}…${DEST.slice(-4)}`);
    assert.strictEqual(truncateMiddle("short"), "short");
  });

  test("copyToClipboard uses the async Clipboard API", async () => {
    let written = "";
    const ok = await copyToClipboard("hello", { writeText: async (t) => void (written = t) });
    assert.strictEqual(ok, true);
    assert.strictEqual(written, "hello");
  });

  test("copyToClipboard returns false (never throws) when clipboard rejects and no DOM", async () => {
    const ok = await copyToClipboard("hello", { writeText: async () => Promise.reject(new Error("denied")) });
    assert.strictEqual(ok, false);
    assert.strictEqual(await copyToClipboard("", { writeText: async () => undefined }), false);
  });
});

describe("QR code generation accuracy (decoded with jsQR)", () => {
  test("pay URI decodes back to the exact URI", () => {
    const uri = buildSep7PayUri({ destination: DEST, amount: "250.75", memoHashHex: MEMO_HEX, networkPassphrase: Networks.TESTNET });
    assert.strictEqual(decodeQrSvg(renderQr(uri)), uri);
  });

  test("credit-asset pay URI with message decodes exactly", () => {
    const uri = buildSep7PayUri({ destination: DEST, amount: "0.0000001", assetCode: "USDC", assetIssuer: ISSUER, message: "Milestone 1 / escrow #7" });
    assert.strictEqual(decodeQrSvg(renderQr(uri)), uri);
  });

  test("tx URI with full envelope XDR decodes exactly at level L", () => {
    const uri = buildSep7TxUri({ xdr: buildTestEnvelope(), networkPassphrase: Networks.TESTNET });
    const decoded = decodeQrSvg(renderQr(uri, "L"));
    assert.strictEqual(decoded, uri);
    assert.strictEqual(parseSep7Uri(decoded!).params.network_passphrase, Networks.TESTNET);
  });

  test("different inputs produce different symbols; same input is deterministic", () => {
    const a = buildSep7PayUri({ destination: DEST, amount: "1" });
    const b = buildSep7PayUri({ destination: DEST, amount: "2" });
    assert.strictEqual(renderQr(a), renderQr(a));
    assert.notStrictEqual(renderQr(a), renderQr(b));
  });
});

describe("<PaymentQR /> rendering", () => {
  test("renders an SVG QR whose payload decodes to the model URI, plus amount, destination, memo and copy buttons", () => {
    const html = renderToStaticMarkup(
      React.createElement(PaymentQR, {
        destination: DEST,
        amount: "99.9900",
        memoHashHex: MEMO_HEX,
        networkPassphrase: Networks.TESTNET,
      })
    );
    const model = buildPaymentQrModel({ destination: DEST, amount: "99.9900", memoHashHex: MEMO_HEX, networkPassphrase: Networks.TESTNET });
    assert.ok(model.ok);
    assert.match(html, /<svg[^>]*data-testid="payment-qr-svg"/);
    assert.ok(html.includes("99.99 XLM"));
    assert.ok(html.includes(DEST));
    assert.ok(html.includes(MEMO_HEX));
    assert.ok(html.includes("Copy address"));
    assert.ok(html.includes("Copy payment URI"));
    const svg = /<svg[\s\S]*?<\/svg>/.exec(html)![0];
    // Component uses marginSize=2; strip it by decoding with the same helper (quiet zone added on top is fine).
    assert.strictEqual(decodeQrSvg(svg), model.uri);
  });

  test("renders an accessible error state instead of a QR for invalid input", () => {
    const html = renderToStaticMarkup(React.createElement(PaymentQR, { destination: DEST, amount: "-5" }));
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes("Unable to generate payment QR code"));
    assert.ok(!html.includes("<svg data-testid=\"payment-qr-svg\""));
    assert.ok(!html.includes("payment-qr-svg"));
  });
});
