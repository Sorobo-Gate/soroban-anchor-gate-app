"use client";

import * as React from "react";
import { QRCodeSVG } from "qrcode.react";
import { Networks, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { Check, Copy, QrCode, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * SEP-0007 scan-to-pay QR generation.
 *
 * Two URI operations are supported:
 *  - `web+stellar:pay` — a plain payment request (destination, amount, asset, MEMO_HASH memo).
 *  - `web+stellar:tx`  — a fully-built transaction envelope (e.g. a prepared `create_escrow`
 *                        Soroban invocation) that the mobile wallet only needs to sign & submit.
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 */

export const SEP7_SCHEME = "web+stellar:";
/** SEP-0007 caps the `msg` parameter at 300 characters. */
export const SEP7_MAX_MESSAGE_LENGTH = 300;
/** Stellar amounts carry at most 7 decimal places (1 stroop = 0.0000001). */
export const STELLAR_AMOUNT_DECIMALS = 7;
/** Largest representable amount: (2^63 - 1) stroops. */
export const MAX_STELLAR_AMOUNT_STROOPS = 9223372036854775807n;
/**
 * Practical upper bound for a scannable QR payload. A version-40 symbol at error-correction
 * level "L" holds 2,953 bytes; we keep headroom so phone cameras can still resolve the modules.
 */
export const MAX_QR_PAYLOAD_LENGTH = 2900;
/** Above this length we drop to error-correction "L" to keep module density scannable. */
export const HIGH_DENSITY_THRESHOLD = 600;

export type QrErrorCorrectionLevel = "L" | "M" | "Q" | "H";

export interface PaymentRequestDetails {
  /** Destination account (G... or muxed M...) receiving the funds. */
  destination: string;
  /** Decimal token amount, e.g. "125.50". */
  amount: string;
  /** Asset code; omit or use "XLM" (with no issuer) for native lumens. */
  assetCode?: string;
  /** Issuer account (G...) — required for every non-native asset. */
  assetIssuer?: string;
  /** 32-byte memo hash as 64 hex chars (e.g. the escrow routing `profile_hash`). */
  memoHashHex?: string;
  /** Optional human-readable message shown by the wallet (max 300 chars). */
  message?: string;
  /** Network passphrase; omitted from the URI for the public network (SEP-0007 default). */
  networkPassphrase?: string;
}

export interface TransactionRequestDetails {
  /** Base64 transaction envelope XDR to be signed by the scanning wallet. */
  xdr: string;
  message?: string;
  networkPassphrase?: string;
}

/** Trims and asserts a value is a valid Stellar destination account (G... or M...). */
export function validateDestination(destination: string): string {
  const value = (destination ?? "").trim();
  if (!value) {
    throw new Error("Destination address is required.");
  }
  if (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidMed25519PublicKey(value)) {
    throw new Error(
      `Invalid destination address: "${value}". Must be a valid Stellar account (G...) or muxed account (M...).`
    );
  }
  return value;
}

/**
 * Validates a decimal amount string and returns its canonical form
 * (no leading zeros, no trailing fractional zeros). Rejects exponents, signs,
 * zero, more than 7 decimals, and values beyond the int64 stroop limit.
 */
export function normalizeAmount(amount: string): string {
  const value = (amount ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid amount: "${amount}". Use a plain positive decimal such as 125.50.`);
  }
  const [rawInt, rawFrac = ""] = value.split(".");
  if (rawFrac.length > STELLAR_AMOUNT_DECIMALS) {
    throw new Error(`Amount supports at most ${STELLAR_AMOUNT_DECIMALS} decimal places.`);
  }
  const stroops = BigInt(rawInt + rawFrac.padEnd(STELLAR_AMOUNT_DECIMALS, "0"));
  if (stroops <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  if (stroops > MAX_STELLAR_AMOUNT_STROOPS) {
    throw new Error("Amount exceeds the maximum Stellar amount (922337203685.4775807).");
  }
  const intPart = rawInt.replace(/^0+(?=\d)/, "");
  const fracPart = rawFrac.replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/** Converts a 64-char hex memo hash into the base64 encoding SEP-0007 requires for MEMO_HASH. */
export function memoHashHexToBase64(memoHashHex: string): string {
  const value = (memoHashHex ?? "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Memo hash must be exactly 32 bytes (64 hexadecimal characters).");
  }
  let binary = "";
  for (let i = 0; i < value.length; i += 2) {
    binary += String.fromCharCode(parseInt(value.slice(i, i + 2), 16));
  }
  return btoa(binary);
}

/** Inverse of {@link memoHashHexToBase64}. */
export function memoHashBase64ToHex(memoBase64: string): string {
  let binary: string;
  try {
    binary = atob(memoBase64);
  } catch {
    throw new Error("Memo hash is not valid base64.");
  }
  if (binary.length !== 32) {
    throw new Error("Decoded memo hash must be exactly 32 bytes.");
  }
  return Array.from(binary, (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

function validateAsset(assetCode?: string, assetIssuer?: string): { code?: string; issuer?: string } {
  const code = assetCode?.trim();
  const issuer = assetIssuer?.trim();
  const isNative = !code || (code.toUpperCase() === "XLM" && !issuer);
  if (isNative) {
    if (issuer) {
      throw new Error("Native XLM payments must not specify an asset issuer.");
    }
    return {};
  }
  if (!/^[a-zA-Z0-9]{1,12}$/.test(code)) {
    throw new Error(`Invalid asset code: "${code}". Must be 1-12 alphanumeric characters.`);
  }
  if (!issuer || !StrKey.isValidEd25519PublicKey(issuer)) {
    throw new Error(`Asset "${code}" requires a valid issuer account (G...).`);
  }
  return { code, issuer };
}

/** Accepts accounts (G/M) and contracts (C) — used for display-only destinations in tx mode. */
export function validateDisplayAddress(address: string): string {
  const value = (address ?? "").trim();
  if (StrKey.isValidContract(value)) return value;
  return validateDestination(value);
}

function validateAssetCodeOnly(assetCode?: string): { code?: string } {
  const code = assetCode?.trim();
  if (!code) return {};
  if (!/^[a-zA-Z0-9]{1,12}$/.test(code)) {
    throw new Error(`Invalid asset code: "${code}". Must be 1-12 alphanumeric characters.`);
  }
  return { code };
}

function validateMessage(message?: string): string | undefined {
  const value = message?.trim();
  if (!value) return undefined;
  if (value.length > SEP7_MAX_MESSAGE_LENGTH) {
    throw new Error(`Message exceeds the SEP-0007 limit of ${SEP7_MAX_MESSAGE_LENGTH} characters.`);
  }
  return value;
}

function encodeParams(params: Array<[string, string | undefined]>): string {
  return params
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

function networkParam(networkPassphrase?: string): string | undefined {
  const value = networkPassphrase?.trim();
  return value && value !== Networks.PUBLIC ? value : undefined;
}

/** Builds a SEP-0007 `web+stellar:pay` URI. Throws a descriptive error on invalid input. */
export function buildSep7PayUri(details: PaymentRequestDetails): string {
  const destination = validateDestination(details.destination);
  const amount = normalizeAmount(details.amount);
  const asset = validateAsset(details.assetCode, details.assetIssuer);
  const memo = details.memoHashHex ? memoHashHexToBase64(details.memoHashHex) : undefined;
  const msg = validateMessage(details.message);

  const query = encodeParams([
    ["destination", destination],
    ["amount", amount],
    ["asset_code", asset.code],
    ["asset_issuer", asset.issuer],
    ["memo", memo],
    ["memo_type", memo ? "MEMO_HASH" : undefined],
    ["msg", msg],
    ["network_passphrase", networkParam(details.networkPassphrase)],
  ]);
  return `${SEP7_SCHEME}pay?${query}`;
}

/** Builds a SEP-0007 `web+stellar:tx` URI after verifying the XDR decodes as an envelope. */
export function buildSep7TxUri(details: TransactionRequestDetails): string {
  const envelope = (details.xdr ?? "").trim();
  if (!envelope) {
    throw new Error("Transaction XDR is required.");
  }
  try {
    TransactionBuilder.fromXDR(envelope, details.networkPassphrase?.trim() || Networks.PUBLIC);
  } catch {
    throw new Error("Transaction XDR is not a valid base64 transaction envelope.");
  }
  const query = encodeParams([
    ["xdr", envelope],
    ["msg", validateMessage(details.message)],
    ["network_passphrase", networkParam(details.networkPassphrase)],
  ]);
  return `${SEP7_SCHEME}tx?${query}`;
}

export interface ParsedSep7Uri {
  operation: "pay" | "tx";
  params: Record<string, string>;
}

/** Parses a SEP-0007 URI back into its operation and decoded parameters. */
export function parseSep7Uri(uri: string): ParsedSep7Uri {
  if (!uri.startsWith(SEP7_SCHEME)) {
    throw new Error(`Not a SEP-0007 URI (expected "${SEP7_SCHEME}" scheme).`);
  }
  const rest = uri.slice(SEP7_SCHEME.length);
  const queryIndex = rest.indexOf("?");
  const operation = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  if (operation !== "pay" && operation !== "tx") {
    throw new Error(`Unsupported SEP-0007 operation: "${operation}".`);
  }
  const params: Record<string, string> = {};
  const query = queryIndex === -1 ? "" : rest.slice(queryIndex + 1);
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    params[key] = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1));
  }
  return { operation, params };
}

/** Picks the strongest error-correction level that keeps the payload comfortably scannable. */
export function selectErrorCorrectionLevel(payloadLength: number): QrErrorCorrectionLevel {
  return payloadLength > HIGH_DENSITY_THRESHOLD ? "L" : "M";
}

/** Shortens a long address for display: GABCDE…WXYZ. */
export function truncateMiddle(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export type PaymentQrModel =
  | {
      ok: true;
      uri: string;
      level: QrErrorCorrectionLevel;
      destination: string;
      amount: string;
      assetLabel: string;
      memoHashHex?: string;
      operation: "pay" | "tx";
    }
  | { ok: false; error: string };

export interface PaymentQrInput extends PaymentRequestDetails {
  /** When supplied, a `tx` URI encoding this envelope is generated instead of a `pay` URI. */
  xdr?: string;
}

/**
 * Pure view-model for {@link PaymentQR}: validates every field, builds the URI,
 * and picks an error-correction level. Never throws — errors are returned as data
 * so the component can render a safe fallback instead of a misleading QR code.
 */
export function buildPaymentQrModel(input: PaymentQrInput): PaymentQrModel {
  try {
    const isTx = Boolean(input.xdr);
    // In tx mode the destination/asset are display-only (the envelope is authoritative),
    // so an escrow contract address (C...) is allowed and the issuer is not required.
    const destination = isTx ? validateDisplayAddress(input.destination) : validateDestination(input.destination);
    const amount = normalizeAmount(input.amount);
    const asset = isTx ? validateAssetCodeOnly(input.assetCode) : validateAsset(input.assetCode, input.assetIssuer);
    const memoHashHex = input.memoHashHex
      ? input.memoHashHex.trim().replace(/^0x/i, "").toLowerCase()
      : undefined;
    if (memoHashHex) memoHashHexToBase64(memoHashHex);

    const operation = isTx ? "tx" : "pay";
    const uri =
      operation === "tx"
        ? buildSep7TxUri({
            xdr: input.xdr as string,
            message: input.message,
            networkPassphrase: input.networkPassphrase,
          })
        : buildSep7PayUri(input);

    if (uri.length > MAX_QR_PAYLOAD_LENGTH) {
      return {
        ok: false,
        error: `Payment request is too large to encode as a scannable QR code (${uri.length} > ${MAX_QR_PAYLOAD_LENGTH} characters). Use the copy button to share the URI instead.`,
      };
    }

    return {
      ok: true,
      uri,
      level: selectErrorCorrectionLevel(uri.length),
      destination,
      amount,
      assetLabel: asset.code ?? "XLM",
      memoHashHex,
      operation,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/**
 * Copies text using the async Clipboard API, falling back to a hidden textarea +
 * `execCommand("copy")` for insecure contexts / older mobile browsers.
 * Resolves `true` on success, `false` otherwise — never throws.
 */
export async function copyToClipboard(
  text: string,
  clipboard: ClipboardLike | undefined = typeof navigator !== "undefined" ? navigator.clipboard : undefined
): Promise<boolean> {
  if (!text) return false;
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  if (typeof document === "undefined") return false;
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export interface PaymentQRProps extends PaymentQrInput {
  /** Rendered QR edge length in CSS pixels. */
  size?: number;
  className?: string;
  /** Called after a copy attempt with what was copied and whether it succeeded. */
  onCopy?: (target: "address" | "uri", success: boolean) => void;
}

const COPY_RESET_MS = 2000;

/**
 * Scan-to-pay card: a dynamic SVG QR code (SEP-0007) plus the human-readable
 * amount, destination and memo hash, with one-click copy for the address and URI.
 */
export function PaymentQR({ size = 224, className = "", onCopy, ...input }: PaymentQRProps) {
  const { destination, amount, assetCode, assetIssuer, memoHashHex, message, networkPassphrase, xdr } = input;
  const model = React.useMemo(
    () =>
      buildPaymentQrModel({ destination, amount, assetCode, assetIssuer, memoHashHex, message, networkPassphrase, xdr }),
    [destination, amount, assetCode, assetIssuer, memoHashHex, message, networkPassphrase, xdr]
  );
  const [copied, setCopied] = React.useState<"address" | "uri" | null>(null);
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );

  const handleCopy = async (target: "address" | "uri", text: string) => {
    const success = await copyToClipboard(text);
    onCopy?.(target, success);
    if (!success) return;
    setCopied(target);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(null), COPY_RESET_MS);
  };

  if (!model.ok) {
    return (
      <div
        role="alert"
        data-testid="payment-qr-error"
        className={`flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive ${className}`}
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold">Unable to generate payment QR code</p>
          <p className="mt-1 text-xs">{model.error}</p>
        </div>
      </div>
    );
  }

  const qrTitle = `Scan to ${model.operation === "tx" ? "sign the escrow funding transaction" : "pay"} ${model.amount} ${model.assetLabel}`;

  return (
    <div
      data-testid="payment-qr"
      className={`flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-start ${className}`}
    >
      <div className="mx-auto shrink-0 rounded-xl bg-white p-3 sm:mx-0">
        <QRCodeSVG
          value={model.uri}
          size={size}
          level={model.level}
          marginSize={2}
          title={qrTitle}
          role="img"
          aria-label={qrTitle}
          data-testid="payment-qr-svg"
        />
      </div>

      <div className="min-w-0 flex-1 space-y-3 text-sm">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <QrCode className="h-4 w-4" aria-hidden="true" />
          <span>{model.operation === "tx" ? "Scan to sign in mobile wallet" : "Scan to pay from mobile wallet"}</span>
        </div>

        <dl className="space-y-2">
          <div>
            <dt className="text-xs text-muted-foreground">Amount</dt>
            <dd className="font-mono text-lg font-semibold text-foreground" data-testid="payment-qr-amount">
              {model.amount} {model.assetLabel}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Destination</dt>
            <dd className="font-mono text-xs text-foreground break-all" title={model.destination}>
              {model.destination}
            </dd>
          </div>
          {model.memoHashHex && (
            <div>
              <dt className="text-xs text-muted-foreground">Memo hash (MEMO_HASH)</dt>
              <dd className="font-mono text-xs text-foreground break-all" data-testid="payment-qr-memo">
                {model.memoHashHex}
              </dd>
            </div>
          )}
        </dl>

        <div className="flex flex-wrap gap-2" aria-live="polite">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-12 sm:min-h-9"
            onClick={() => handleCopy("address", model.destination)}
            aria-label="Copy destination address"
          >
            {copied === "address" ? <Check className="mr-1 h-3 w-3" aria-hidden="true" /> : <Copy className="mr-1 h-3 w-3" aria-hidden="true" />}
            {copied === "address" ? "Address copied" : "Copy address"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-12 sm:min-h-9"
            onClick={() => handleCopy("uri", model.uri)}
            aria-label="Copy SEP-0007 payment URI"
          >
            {copied === "uri" ? <Check className="mr-1 h-3 w-3" aria-hidden="true" /> : <Copy className="mr-1 h-3 w-3" aria-hidden="true" />}
            {copied === "uri" ? "URI copied" : "Copy payment URI"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default PaymentQR;
