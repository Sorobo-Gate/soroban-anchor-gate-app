import assert from "node:assert";
import { describe, test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import {
  ESCROW_CONTRACT_ERRORS,
  SimulationModal,
  buildCostRows,
  explainSimulationError,
  formatBytes,
  formatCount,
  runPreflightSimulation,
  stroopsToXlm,
  summarizeSimulation,
  type SimulationServer,
} from "../components/SimulationModal";

const base = { id: "1", latestLedger: 100, events: [], _parsed: true };

function successSim(opts: { instructions?: number; read?: number; write?: number; fee?: string } = {}): rpc.Api.SimulateTransactionSuccessResponse {
  const data = new SorobanDataBuilder()
    .setResources(opts.instructions ?? 4_250_000, opts.read ?? 2048, opts.write ?? 512)
    .setResourceFee(opts.fee ?? "85000");
  return { ...base, transactionData: data, minResourceFee: opts.fee ?? "85000" };
}

function errorSim(error: string): rpc.Api.SimulateTransactionErrorResponse {
  return { ...base, error };
}

function buildTx(fee = "100000"): Transaction {
  const source = new Account(Keypair.random().publicKey(), "1");
  return new TransactionBuilder(source, { fee, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" }))
    .setTimeout(300)
    .build();
}

const serverReturning = (result: rpc.Api.SimulateTransactionResponse | Error): SimulationServer & { calls: number } => {
  const s = {
    calls: 0,
    async simulateTransaction() {
      s.calls += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return s;
};

describe("stroopsToXlm / formatting", () => {
  test("converts without floating point error", () => {
    assert.strictEqual(stroopsToXlm(0n), "0.0000000");
    assert.strictEqual(stroopsToXlm(1n), "0.0000001");
    assert.strictEqual(stroopsToXlm(185_000n), "0.0185000");
    assert.strictEqual(stroopsToXlm("123456789012"), "12345.6789012");
    assert.strictEqual(stroopsToXlm(-5n), "-0.0000005");
  });

  test("formatCount and formatBytes", () => {
    assert.strictEqual(formatCount(4250000), "4,250,000");
    assert.strictEqual(formatCount(0), "0");
    assert.strictEqual(formatBytes(512), "512 B");
    assert.strictEqual(formatBytes(2048), "2.0 KB");
    assert.strictEqual(formatBytes(3 * 1024 * 1024), "3.00 MB");
    assert.strictEqual(formatBytes(-1), "0 B");
    assert.strictEqual(formatBytes(Number.NaN), "0 B");
  });
});

describe("summarizeSimulation", () => {
  test("extracts CPU, memory footprint and fee breakdown", () => {
    const summary = summarizeSimulation(successSim(), "100000");
    assert.strictEqual(summary.cpuInstructions, 4_250_000);
    assert.strictEqual(summary.diskReadBytes, 2048);
    assert.strictEqual(summary.writeBytes, 512);
    assert.strictEqual(summary.memoryFootprintBytes, 2560);
    assert.strictEqual(summary.resourceFeeStroops, 85_000n);
    assert.strictEqual(summary.inclusionFeeStroops, 100_000n);
    assert.strictEqual(summary.totalFeeStroops, 185_000n);
    assert.strictEqual(summary.totalFeeXlm, "0.0185000");
    assert.strictEqual(summary.requiresRestore, false);
  });

  test("tolerates a zero-resource simulation", () => {
    const summary = summarizeSimulation(successSim({ instructions: 0, read: 0, write: 0, fee: "0" }), 0);
    assert.strictEqual(summary.cpuInstructions, 0);
    assert.strictEqual(summary.totalFeeXlm, "0.0000000");
  });

  test("buildCostRows exposes CPU, memory and XLM fee rows", () => {
    const rows = buildCostRows(summarizeSimulation(successSim(), 100000));
    assert.deepStrictEqual(rows.map((r) => r.label), ["CPU instructions", "Memory / ledger footprint", "Estimated network fee"]);
    assert.strictEqual(rows[0].value, "4,250,000");
    assert.strictEqual(rows[1].value, "2.5 KB");
    assert.strictEqual(rows[2].value, "0.0185000 XLM");
    assert.match(rows[2].hint, /0\.0085000 resource \+ 0\.0100000 inclusion/);
  });
});

describe("explainSimulationError", () => {
  test("maps every EscrowError contract code to plain language", () => {
    for (const [code, info] of Object.entries(ESCROW_CONTRACT_ERRORS)) {
      const result = explainSimulationError(`HostError: Error(Contract, #${code})\nEvent log...`);
      assert.strictEqual(result.category, "contract");
      assert.strictEqual(result.code, `Contract #${code}`);
      assert.ok(result.title.includes(info.name));
      assert.strictEqual(result.explanation, info.explanation);
    }
  });

  test("contract codes stay in sync with contracts/src/errors.rs", async (t) => {
    const { readFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const path = new URL("../../../../contracts/src/errors.rs", import.meta.url);
    if (!existsSync(path)) {
      t.skip("contracts/ not present in this checkout");
      return;
    }
    const source = await readFile(path, "utf8");
    const entries = [...source.matchAll(/^\s*(\w+)\s*=\s*(\d+),/gm)].map((m) => [Number(m[2]), m[1]] as const);
    assert.ok(entries.length > 0);
    for (const [code, name] of entries) {
      assert.strictEqual(ESCROW_CONTRACT_ERRORS[code]?.name, name, `code ${code} should be ${name}`);
    }
  });

  test("handles unknown contract codes", () => {
    const result = explainSimulationError("Error(Contract, #999)");
    assert.strictEqual(result.category, "contract");
    assert.match(result.title, /#999/);
  });

  test("explains host errors (auth, storage, budget)", () => {
    assert.strictEqual(explainSimulationError("Error(Auth, InvalidAction)").category, "host");
    assert.match(explainSimulationError("Error(Auth, InvalidAction)").explanation, /signature or authorisation/);
    assert.match(explainSimulationError("HostError: Error(Storage, MissingValue)").explanation, /not found/);
    assert.match(explainSimulationError("Error(Budget, ExceededLimit)").explanation, /budget/);
  });

  test("explains balance, account, and network failures", () => {
    assert.strictEqual(explainSimulationError("balance is not sufficient to spend").category, "balance");
    assert.strictEqual(explainSimulationError("Account not found: GABC").category, "account");
    assert.strictEqual(explainSimulationError("TypeError: fetch failed").category, "network");
  });

  test("falls back safely for empty / unknown input", () => {
    assert.strictEqual(explainSimulationError(undefined).category, "unknown");
    assert.strictEqual(explainSimulationError("").title, "Simulation failed");
    assert.strictEqual(explainSimulationError("something odd").raw, "something odd");
  });
});

describe("runPreflightSimulation", () => {
  test("simulates, assembles and returns a cost summary on success", async () => {
    const server = serverReturning(successSim());
    const tx = buildTx("100000");
    let assembled = false;
    const result = await runPreflightSimulation(server, tx, (t) => {
      assembled = true;
      return t;
    });
    assert.strictEqual(server.calls, 1);
    assert.ok(assembled);
    assert.ok(result.ok);
    if (result.ok) {
      assert.strictEqual(result.summary.inclusionFeeStroops, 100_000n);
      assert.strictEqual(result.summary.totalFeeXlm, "0.0185000");
      assert.strictEqual(result.preparedTx, tx);
    }
  });

  test("returns an explained revert without assembling when simulation fails", async () => {
    let assembled = false;
    const result = await runPreflightSimulation(serverReturning(errorSim("HostError: Error(Contract, #6)")), buildTx(), (t) => {
      assembled = true;
      return t;
    });
    assert.strictEqual(assembled, false);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.error.title, "Contract rejected the transaction: UnlockTimeNotReached");
  });

  test("never throws on transport errors", async () => {
    const result = await runPreflightSimulation(serverReturning(new Error("fetch failed")), buildTx());
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.error.category, "network");
  });

  test("flags archived state that needs restoring", async () => {
    const sim = {
      ...successSim(),
      result: { auth: [], retval: undefined as never },
      restorePreamble: { minResourceFee: "100", transactionData: new SorobanDataBuilder() },
    } as rpc.Api.SimulateTransactionRestoreResponse;
    const result = await runPreflightSimulation(serverReturning(sim), buildTx(), (t) => t);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.error.title, /restored/);
  });

  test("captures assembly failures", async () => {
    const result = await runPreflightSimulation(serverReturning(successSim()), buildTx(), () => {
      throw new Error("Error(Value, InvalidInput)");
    });
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.error.category, "host");
  });
});

describe("<SimulationModal /> rendering", () => {
  const noop = () => undefined;

  test("renders nothing when closed", () => {
    const html = renderToStaticMarkup(
      React.createElement(SimulationModal, { open: false, state: { phase: "simulating" }, actionLabel: "x", onConfirm: noop, onCancel: noop })
    );
    assert.strictEqual(html, "");
  });

  test("simulating phase shows a status and a disabled continue button", () => {
    const html = renderToStaticMarkup(
      React.createElement(SimulationModal, { open: true, state: { phase: "simulating" }, actionLabel: "refund", onConfirm: noop, onCancel: noop })
    );
    assert.ok(html.includes('role="status"'));
    assert.match(html, /<button[^>]*disabled=""[^>]*>Continue to wallet signature/);
  });

  test("ready phase shows CPU, memory and XLM fee breakdown with enabled continue", () => {
    const summary = summarizeSimulation(successSim(), 100000);
    const html = renderToStaticMarkup(
      React.createElement(SimulationModal, { open: true, state: { phase: "ready", summary }, actionLabel: "escrow deposit (10 XLM)", onConfirm: noop, onCancel: noop })
    );
    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('aria-modal="true"'));
    assert.ok(html.includes("CPU instructions"));
    assert.ok(html.includes("4,250,000"));
    assert.ok(html.includes("Memory / ledger footprint"));
    assert.ok(html.includes("0.0185000 XLM"));
    assert.ok(html.includes("escrow deposit (10 XLM)"));
    assert.doesNotMatch(html, /disabled=""[^>]*>Continue to wallet signature/);
  });

  test("reverted phase shows a prominent alert and no signing button", () => {
    const error = explainSimulationError("Error(Contract, #3)");
    const html = renderToStaticMarkup(
      React.createElement(SimulationModal, { open: true, state: { phase: "reverted", error }, actionLabel: "release", onConfirm: noop, onCancel: noop })
    );
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes("Transaction would fail"));
    assert.ok(html.includes("Unauthorized"));
    assert.ok(html.includes("no funds have moved"));
    assert.ok(!html.includes("Continue to wallet signature"));
  });
});
