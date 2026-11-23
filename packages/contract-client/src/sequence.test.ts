import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { AccountSequenceManager } from "./sequence.js";

describe("AccountSequenceManager - Speculative Sequence Queue", () => {
  let manager: AccountSequenceManager;
  const ALICE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const BOB = "GBZNVPRG6YJHIQ6PR7RN3P4S76V2T63WQL6Q2O22W4P6L5V3L7T2PQR4";

  beforeEach(() => {
    manager = new AccountSequenceManager();
  });

  it("fetches initial sequence from on-chain and increments atomically", async () => {
    let rpcCallCount = 0;
    const fetchOnChain = async () => {
      rpcCallCount++;
      return 100n;
    };

    const seq1 = await manager.nextSequence(ALICE, fetchOnChain);
    const seq2 = await manager.nextSequence(ALICE, fetchOnChain);
    const seq3 = await manager.nextSequence(ALICE, fetchOnChain);

    assert.strictEqual(seq1, 101n);
    assert.strictEqual(seq2, 102n);
    assert.strictEqual(seq3, 103n);
    assert.strictEqual(rpcCallCount, 1, "fetchOnChain should only be called once initially");
    assert.strictEqual(manager.getPendingCount(ALICE), 3);
  });

  it("safely handles highly concurrent parallel transaction dispatch without collision", async () => {
    const fetchOnChain = async () => 500n;
    const count = 50;

    // Dispatch 50 concurrent sequence requests simultaneously
    const promises = Array.from({ length: count }, () =>
      manager.nextSequence(ALICE, fetchOnChain),
    );

    const results = await Promise.all(promises);

    // Verify all sequence numbers are unique and strictly monotonic from 501 to 550
    assert.strictEqual(results.length, count);
    const unique = new Set(results.map((n) => n.toString()));
    assert.strictEqual(unique.size, count, "All sequence numbers must be distinct");

    const minSeq = results.reduce((min, cur) => (cur < min ? cur : min), results[0]);
    const maxSeq = results.reduce((max, cur) => (cur > max ? cur : max), results[0]);
    assert.strictEqual(minSeq, 501n);
    assert.strictEqual(maxSeq, 550n);
    assert.strictEqual(manager.getPendingCount(ALICE), count);
  });

  it("prunes confirmed sequences on confirmation", async () => {
    const fetchOnChain = async () => 200n;
    await manager.nextSequence(ALICE, fetchOnChain); // 201
    await manager.nextSequence(ALICE, fetchOnChain); // 202
    await manager.nextSequence(ALICE, fetchOnChain); // 203

    assert.strictEqual(manager.getPendingCount(ALICE), 3);

    // Confirm sequence 202
    await manager.confirmSequence(ALICE, 202n);

    // Sequences <= 202 should be pruned, only 203 remains
    assert.strictEqual(manager.getPendingCount(ALICE), 1);
    const pending = manager.getPendingSequences(ALICE);
    assert.strictEqual(pending[0].sequence, 203n);
  });

  it("rolls back speculative sequence on transaction failure without RPC callback", async () => {
    const fetchOnChain = async () => 300n;
    const s1 = await manager.nextSequence(ALICE, fetchOnChain); // 301
    const s2 = await manager.nextSequence(ALICE, fetchOnChain); // 302
    const s3 = await manager.nextSequence(ALICE, fetchOnChain); // 303

    assert.strictEqual(manager.getPendingCount(ALICE), 3);

    // Sequence 302 failed, roll back
    await manager.rollbackSequence(ALICE, 302n);

    // Sequences 302 and 303 pruned, 301 remains
    assert.strictEqual(manager.getPendingCount(ALICE), 1);
    assert.strictEqual(await manager.getSequence(ALICE), 301n);

    // Next sequence continues from 302
    const nextSeq = await manager.nextSequence(ALICE, fetchOnChain);
    assert.strictEqual(nextSeq, 302n);
  });

  it("rolls back and resyncs with on-chain sequence when fetchOnChain is provided", async () => {
    const fetchOnChain = async () => 400n;
    await manager.nextSequence(ALICE, fetchOnChain); // 401
    await manager.nextSequence(ALICE, fetchOnChain); // 402

    // Transaction 401 failed on-chain, on-chain sequence still at 400
    await manager.rollbackSequence(ALICE, 401n, async () => 400n);

    assert.strictEqual(manager.getPendingCount(ALICE), 0);
    assert.strictEqual(await manager.getSequence(ALICE), 400n);

    const reattempt = await manager.nextSequence(ALICE, fetchOnChain);
    assert.strictEqual(reattempt, 401n);
  });

  it("tracks independent accounts separately", async () => {
    const fetchAlice = async () => 100n;
    const fetchBob = async () => 200n;

    const alice1 = await manager.nextSequence(ALICE, fetchAlice);
    const bob1 = await manager.nextSequence(BOB, fetchBob);
    const alice2 = await manager.nextSequence(ALICE, fetchAlice);

    assert.strictEqual(alice1, 101n);
    assert.strictEqual(bob1, 201n);
    assert.strictEqual(alice2, 102n);

    assert.strictEqual(manager.getPendingCount(ALICE), 2);
    assert.strictEqual(manager.getPendingCount(BOB), 1);

    manager.reset(ALICE);
    assert.strictEqual(manager.getPendingCount(ALICE), 0);
    assert.strictEqual(manager.getPendingCount(BOB), 1);
  });
});
