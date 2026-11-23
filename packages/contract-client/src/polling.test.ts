import assert from "node:assert";
import { test, describe } from "node:test";
import { pollTransactionStatus } from "./polling";

const txHash = "a".repeat(64);

function sequenceServer(statuses: Array<{ status: string; ledger?: number }>) {
  let index = 0;
  return {
    getTransaction: async () => statuses[Math.min(index++, statuses.length - 1)],
  } as never;
}

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    elapsed: () => time,
  };
}

describe("pollTransactionStatus", () => {
  test("backs off exponentially until SUCCESS", async () => {
    const clock = fakeClock();
    const delays: number[] = [];
    const receipt = await pollTransactionStatus(txHash, {
      server: sequenceServer([
        { status: "PENDING" },
        { status: "NOT_FOUND" },
        { status: "SUCCESS", ledger: 42 },
      ]),
      now: clock.now,
      sleep: async (ms) => {
        delays.push(ms);
        await clock.sleep(ms);
      },
    });

    assert.strictEqual(receipt.status, "SUCCESS");
    assert.strictEqual(receipt.ledger, 42);
    assert.strictEqual(receipt.attempts, 3);
    assert.strictEqual(receipt.elapsedMs, 1_500);
    assert.deepStrictEqual(delays, [500, 1_000]);
  });

  test("caps the delay at maxDelayMs", async () => {
    const clock = fakeClock();
    const delays: number[] = [];
    await pollTransactionStatus(txHash, {
      server: sequenceServer([
        { status: "PENDING" },
        { status: "PENDING" },
        { status: "PENDING" },
        { status: "SUCCESS", ledger: 7 },
      ]),
      initialDelayMs: 500,
      maxDelayMs: 800,
      now: clock.now,
      sleep: async (ms) => {
        delays.push(ms);
        await clock.sleep(ms);
      },
    });
    assert.deepStrictEqual(delays, [500, 800, 800]);
  });

  test("throws immediately when the transaction FAILED", async () => {
    const clock = fakeClock();
    await assert.rejects(
      pollTransactionStatus(txHash, {
        server: sequenceServer([{ status: "FAILED", ledger: 42 }]),
        now: clock.now,
        sleep: clock.sleep,
      }),
      /failed in ledger 42/
    );
  });

  test("times out with diagnostics while still pending", async () => {
    const clock = fakeClock();
    await assert.rejects(
      pollTransactionStatus(txHash, {
        server: sequenceServer([{ status: "NOT_FOUND" }]),
        timeoutMs: 2_000,
        now: clock.now,
        sleep: clock.sleep,
      }),
      /Timed out after 2000ms.*attempts=3.*lastStatus=PENDING/
    );
  });

  test("rejects invalid hashes and options", async () => {
    await assert.rejects(
      pollTransactionStatus("not-a-hash", { server: sequenceServer([]) }),
      /64 hexadecimal characters/
    );
    await assert.rejects(
      pollTransactionStatus(txHash, { server: sequenceServer([]), timeoutMs: 0 }),
      /timeoutMs/
    );
    await assert.rejects(pollTransactionStatus(txHash), /config or server/);
  });
});
