import assert from "node:assert";
import { describe, test } from "node:test";
import {
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import {
  DEFAULT_TRANSACTION_TIMEOUT_SECONDS,
  TransactionSubmissionError,
  buildUnsignedXDR,
  decodeTransactionXDR,
  submitSignedXDR,
} from "./batch";
import type { ContractCall } from "./batch";
import { MockWalletAdapter } from "./wallets";

const contractId =
  "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const HASH = "ab".repeat(32);

function invocation(overrides: Partial<ContractCall> = {}): ContractCall {
  return {
    sourceAccount: Keypair.random().publicKey(),
    sequence: "4294967296",
    contractId,
    method: "get_escrow",
    args: [nativeToScVal(1n, { type: "u64" })],
    networkPassphrase: TESTNET_PASSPHRASE,
    ...overrides,
  };
}

async function signedEnvelope(): Promise<string> {
  const keypair = Keypair.random();
  const wallet = new MockWalletAdapter({ keypair });
  const { address } = await wallet.connect();
  const unsigned = buildUnsignedXDR(
    invocation({ sourceAccount: address, method: "refund", args: [nativeToScVal(7n, { type: "u64" })] })
  );
  return wallet.signTransaction(unsigned, {
    networkPassphrase: TESTNET_PASSPHRASE,
  });
}

type SubmissionServer = Pick<rpc.Server, "sendTransaction" | "getTransaction">;

function fakeServer(
  send: unknown,
  get: unknown
): SubmissionServer {
  return {
    sendTransaction: async () => send,
    getTransaction: async () => get,
  } as unknown as SubmissionServer;
}

describe("buildUnsignedXDR", () => {
  test("serializes a transaction that round-trips without loss", () => {
    const call = invocation();
    const unsigned = buildUnsignedXDR(call);
    assert.equal(typeof unsigned, "string");
    assert.ok(unsigned.length > 100);

    const decoded = decodeTransactionXDR(unsigned, TESTNET_PASSPHRASE);
    if (decoded instanceof FeeBumpTransaction) {
      throw new Error("expected a single transaction envelope");
    }
    assert.equal(decoded.source, call.sourceAccount);
    // The builder advances the supplied account sequence by one.
    assert.equal(decoded.sequence, String(BigInt(call.sequence) + 1n));
    assert.equal(decoded.operations.length, 1);
    assert.equal(decoded.operations[0].type, "invokeHostFunction");
    assert.equal(decoded.signatures.length, 0);
    assert.equal(decoded.toXDR(), unsigned);
  });

  test("applies fee, timeout, and memo defaults", () => {
    const decoded = decodeTransactionXDR(
      buildUnsignedXDR(invocation()),
      TESTNET_PASSPHRASE
    );
    if (decoded instanceof FeeBumpTransaction) throw new Error("unexpected");
    assert.equal(decoded.fee, "100");
    assert.equal(decoded.memo.type, "none");
    assert.ok(decoded.timeBounds);
    const now = Math.floor(Date.now() / 1000);
    const maxTime = Number(decoded.timeBounds?.maxTime ?? 0);
    assert.ok(
      maxTime >= now + DEFAULT_TRANSACTION_TIMEOUT_SECONDS - 5 &&
        maxTime <= now + DEFAULT_TRANSACTION_TIMEOUT_SECONDS + 5,
      `expected the default timeout to be about ${DEFAULT_TRANSACTION_TIMEOUT_SECONDS}s`
    );
  });

  test("honors explicit fee, timeout, memo, and empty args", () => {
    const decoded = decodeTransactionXDR(
      buildUnsignedXDR(
        invocation({
          method: "get_counter",
          args: [],
          fee: "250",
          timeoutSeconds: 120,
          memo: "batch-1",
        })
      ),
      TESTNET_PASSPHRASE
    );
    if (decoded instanceof FeeBumpTransaction) throw new Error("unexpected");
    assert.equal(decoded.fee, "250");
    assert.equal(decoded.memo.type, "text");
    const memoValue = decoded.memo.value;
    const memoText =
      typeof memoValue === "string"
        ? memoValue
        : new TextDecoder().decode(memoValue as unknown as Uint8Array);
    assert.equal(memoText, "batch-1");
    assert.equal(decoded.operations.length, 1);
  });

  test("produces distinct envelopes for distinct contract arguments", () => {
    const sourceAccount = Keypair.random().publicKey();
    const first = buildUnsignedXDR(
      invocation({
        sourceAccount,
        args: [nativeToScVal(1n, { type: "u64" })],
      })
    );
    const second = buildUnsignedXDR(
      invocation({
        sourceAccount,
        args: [nativeToScVal(2n, { type: "u64" })],
      })
    );
    assert.notEqual(first, second);
  });

  test("rejects malformed invocations before serializing", () => {
    assert.throws(() => buildUnsignedXDR(invocation({ sourceAccount: "" })), /Invalid source account/);
    assert.throws(
      () => buildUnsignedXDR(invocation({ sourceAccount: contractId })),
      /Invalid source account/
    );
    assert.throws(() => buildUnsignedXDR(invocation({ sequence: "12a" })), /sequence/);
    assert.throws(() => buildUnsignedXDR(invocation({ sequence: "" })), /sequence/);
    assert.throws(() => buildUnsignedXDR(invocation({ contractId: "nope" })), /Invalid contract ID/);
    assert.throws(() => buildUnsignedXDR(invocation({ method: "1bad" })), /Invalid contract method/);
    assert.throws(() => buildUnsignedXDR(invocation({ method: "" })), /Invalid contract method/);
    assert.throws(
      () => buildUnsignedXDR(invocation({ networkPassphrase: "  " })),
      /Network passphrase cannot be empty/
    );
    assert.throws(() => buildUnsignedXDR(invocation({ fee: "-1" })), /fee/);
    assert.throws(
      () => buildUnsignedXDR(invocation({ timeoutSeconds: 0 })),
      /timeoutSeconds/
    );
    assert.throws(
      () => buildUnsignedXDR(invocation({ memo: "x".repeat(29) })),
      /28 UTF-8 bytes/
    );
    assert.throws(
      () =>
        buildUnsignedXDR(
          invocation({ args: "not-an-array" as unknown as ContractCall["args"] })
        ),
      /args must be an array/
    );
  });

  test("counts memo length in UTF-8 bytes", () => {
    assert.throws(
      () => buildUnsignedXDR(invocation({ memo: "é".repeat(15) })),
      /28 UTF-8 bytes/
    );
  });
});

describe("decodeTransactionXDR", () => {
  test("rejects empty input and passphrases", () => {
    assert.throws(() => decodeTransactionXDR("", TESTNET_PASSPHRASE), /non-empty/);
    assert.throws(() => decodeTransactionXDR("   ", TESTNET_PASSPHRASE), /non-empty/);
    assert.throws(
      () => decodeTransactionXDR(buildUnsignedXDR(invocation()), ""),
      /Network passphrase/
    );
  });

  test("wraps malformed XDR in a descriptive error", () => {
    assert.throws(
      () => decodeTransactionXDR("AAAA", TESTNET_PASSPHRASE),
      /Invalid transaction XDR/
    );
  });
});

describe("submitSignedXDR", () => {
  test("submits a signed envelope and returns the settled receipt", async () => {
    const signed = await signedEnvelope();
    const receipt = await submitSignedXDR(signed, {
      networkPassphrase: TESTNET_PASSPHRASE,
      server: fakeServer(
        { status: "PENDING", hash: HASH },
        { status: "SUCCESS", ledger: 42, createdAt: 1_700_000_000 }
      ),
    });

    assert.equal(receipt.hash, HASH);
    assert.equal(receipt.status, "SUCCESS");
    assert.equal(receipt.ledger, 42);
    assert.ok(receipt.attempts >= 1);
  });

  test("refuses unsigned envelopes without contacting RPC", async () => {
    let sent = false;
    const server = {
      sendTransaction: async () => {
        sent = true;
        return { status: "PENDING", hash: HASH };
      },
      getTransaction: async () => ({ status: "SUCCESS" }),
    } as unknown as SubmissionServer;

    const error = await submitSignedXDR(buildUnsignedXDR(invocation()), {
      networkPassphrase: TESTNET_PASSPHRASE,
      server,
    }).catch((caught: unknown) => caught);

    assert.ok(error instanceof TransactionSubmissionError);
    assert.equal(error.kind, "rejected");
    assert.equal(sent, false);
  });

  test("requires an RPC server or client configuration", async () => {
    const signed = await signedEnvelope();
    await assert.rejects(
      () =>
        submitSignedXDR(signed, { networkPassphrase: TESTNET_PASSPHRASE }),
      /Either options.server or options.config/
    );
  });

  test("maps RPC rejection to a non-retryable error", async () => {
    const signed = await signedEnvelope();
    const error = await submitSignedXDR(signed, {
      networkPassphrase: TESTNET_PASSPHRASE,
      server: fakeServer(
        { status: "ERROR", hash: HASH },
        { status: "NOT_FOUND" }
      ),
    }).catch((caught: unknown) => caught);

    assert.ok(error instanceof TransactionSubmissionError);
    assert.equal(error.kind, "rejected");
    assert.equal(error.retryable, false);
    assert.equal(error.hash, HASH);
  });

  test("marks TRY_AGAIN_LATER responses as retryable", async () => {
    const signed = await signedEnvelope();
    const error = await submitSignedXDR(signed, {
      networkPassphrase: TESTNET_PASSPHRASE,
      server: fakeServer({ status: "TRY_AGAIN_LATER" }, { status: "NOT_FOUND" }),
    }).catch((caught: unknown) => caught);

    assert.ok(error instanceof TransactionSubmissionError);
    assert.equal(error.kind, "retryable");
    assert.equal(error.retryable, true);
  });

  test("rejects responses without a transaction hash", async () => {
    const signed = await signedEnvelope();
    const error = await submitSignedXDR(signed, {
      networkPassphrase: TESTNET_PASSPHRASE,
      server: fakeServer({ status: "PENDING" }, { status: "SUCCESS" }),
    }).catch((caught: unknown) => caught);

    assert.ok(error instanceof TransactionSubmissionError);
    assert.equal(error.kind, "failed");
    assert.match(error.message, /did not return a transaction hash/);
  });

  test("surfaces a failed ledger result", async () => {
    const signed = await signedEnvelope();
    const error = await submitSignedXDR(signed, {
      networkPassphrase: TESTNET_PASSPHRASE,
      server: fakeServer(
        { status: "PENDING", hash: HASH },
        { status: "FAILED", ledger: 7 }
      ),
    }).catch((caught: unknown) => caught);

    assert.ok(error instanceof TransactionSubmissionError);
    assert.equal(error.kind, "failed");
    assert.equal(error.hash, HASH);
    assert.match(error.message, /did not settle successfully/);
  });

  test("reports a polling timeout", async () => {
    const signed = await signedEnvelope();
    const error = await submitSignedXDR(signed, {
      networkPassphrase: TESTNET_PASSPHRASE,
      server: fakeServer(
        { status: "PENDING", hash: HASH },
        { status: "NOT_FOUND" }
      ),
      timeoutMs: 1,
      initialDelayMs: 1,
      maxDelayMs: 1,
    }).catch((caught: unknown) => caught);

    assert.ok(error instanceof TransactionSubmissionError);
    assert.equal(error.kind, "timeout");
    assert.match(error.message, /polling deadline/);
  });

  test("wraps transport failures as retryable", async () => {
    const signed = await signedEnvelope();
    const server = {
      sendTransaction: async () => {
        throw new Error("socket hang up");
      },
      getTransaction: async () => ({ status: "SUCCESS" }),
    } as unknown as SubmissionServer;

    const error = await submitSignedXDR(signed, {
      networkPassphrase: TESTNET_PASSPHRASE,
      server,
    }).catch((caught: unknown) => caught);

    assert.ok(error instanceof TransactionSubmissionError);
    assert.equal(error.kind, "retryable");
    assert.match(error.message, /socket hang up/);
  });

  test("verifies the signed envelope still parses as a transaction", async () => {
    const signed = await signedEnvelope();
    const parsed = TransactionBuilder.fromXDR(signed, TESTNET_PASSPHRASE);
    assert.equal(parsed.signatures.length, 1);
  });
});
