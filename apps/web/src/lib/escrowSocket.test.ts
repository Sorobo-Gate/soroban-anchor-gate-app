import assert from "node:assert";
import { describe, test, after } from "node:test";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { QueryClient } from "@tanstack/react-query";
import {
  EscrowSocketClient,
  applyEscrowUpdateToCache,
  buildSubscribeMessage,
  buildUnsubscribeMessage,
  computeBackoffDelay,
  escrowChannel,
  escrowQueryKey,
  isValidEscrowId,
  mergeEscrowUpdate,
  parseRelayFrame,
  resolveRelayWsUrl,
  DEFAULT_BACKOFF,
  DEFAULT_RELAY_WS_URL,
  type EscrowCacheEntry,
  type EscrowSocketStatus,
  type EscrowUpdate,
  type WebSocketLike,
} from "../hooks/useEscrowSocket";

const update = (overrides: Partial<EscrowUpdate> = {}): EscrowUpdate => ({
  escrow_id: "42",
  event_id: "evt-1",
  status: "Funded",
  timestamp: "2026-11-20T10:00:00Z",
  ...overrides,
});

const waitFor = async (predicate: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("protocol helpers", () => {
  test("channel and subscribe messages match the relay hub format", () => {
    assert.strictEqual(escrowChannel("42"), "subscribe:escrow:42");
    assert.deepStrictEqual(JSON.parse(buildSubscribeMessage("42")), { action: "subscribe", channel: "subscribe:escrow:42" });
    assert.deepStrictEqual(JSON.parse(buildUnsubscribeMessage("42")), { action: "unsubscribe", channel: "subscribe:escrow:42" });
  });

  test("isValidEscrowId rejects injection-prone ids", () => {
    assert.ok(isValidEscrowId("42"));
    assert.ok(isValidEscrowId("E-001_a"));
    for (const bad of ["", "4 2", "42:evil", "a/b", "x".repeat(129), null, 42]) {
      assert.strictEqual(isValidEscrowId(bad), false, `expected ${String(bad)} rejected`);
    }
  });

  test("resolveRelayWsUrl validates scheme", () => {
    assert.strictEqual(resolveRelayWsUrl("wss://relay.example.com/ws"), "wss://relay.example.com/ws");
    assert.strictEqual(resolveRelayWsUrl(), DEFAULT_RELAY_WS_URL);
    assert.throws(() => resolveRelayWsUrl("https://relay.example.com"), /ws:\/\/ or wss:\/\//);
    assert.throws(() => resolveRelayWsUrl("not a url"), /Invalid relay/);
  });
});

describe("computeBackoffDelay", () => {
  const noJitter = { jitter: 0 };

  test("grows exponentially from the base delay", () => {
    assert.strictEqual(computeBackoffDelay(0, noJitter), DEFAULT_BACKOFF.baseMs);
    assert.strictEqual(computeBackoffDelay(1, noJitter), DEFAULT_BACKOFF.baseMs * 2);
    assert.strictEqual(computeBackoffDelay(3, noJitter), DEFAULT_BACKOFF.baseMs * 8);
  });

  test("is capped at maxMs even for huge attempt counts", () => {
    assert.strictEqual(computeBackoffDelay(50, noJitter), DEFAULT_BACKOFF.maxMs);
    assert.strictEqual(computeBackoffDelay(1e9, noJitter), DEFAULT_BACKOFF.maxMs);
  });

  test("jitter stays within ±jitter bounds", () => {
    const opts = { baseMs: 1000, jitter: 0.2, maxMs: 100_000 };
    assert.strictEqual(computeBackoffDelay(0, opts, () => 0), 800);
    assert.strictEqual(computeBackoffDelay(0, opts, () => 0.5), 1000);
    assert.strictEqual(computeBackoffDelay(0, opts, () => 0.999999), 1200);
  });

  test("handles negative / NaN attempts safely", () => {
    assert.strictEqual(computeBackoffDelay(-5, noJitter), DEFAULT_BACKOFF.baseMs);
    assert.strictEqual(computeBackoffDelay(Number.NaN, noJitter), DEFAULT_BACKOFF.baseMs);
  });
});

describe("parseRelayFrame", () => {
  test("parses a single update", () => {
    assert.deepStrictEqual(parseRelayFrame(JSON.stringify(update())), [update()]);
  });

  test("splits newline-batched frames from the relay writePump", () => {
    const frame = [update({ event_id: "a" }), update({ event_id: "b", status: "Disbursed" })].map((u) => JSON.stringify(u)).join("\n");
    const parsed = parseRelayFrame(frame);
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[1].status, "Disbursed");
  });

  test("drops malformed JSON, wrong shapes, and non-string data", () => {
    const frame = ["{not json", JSON.stringify({ escrow_id: "42" }), JSON.stringify({ ...update(), timestamp: "nope" }), JSON.stringify(update())].join("\n");
    assert.strictEqual(parseRelayFrame(frame).length, 1);
    assert.deepStrictEqual(parseRelayFrame(new ArrayBuffer(4)), []);
    assert.deepStrictEqual(parseRelayFrame(""), []);
    assert.deepStrictEqual(parseRelayFrame(JSON.stringify({ ...update(), payout_amount: 5 })), []);
  });

  test("filters to the expected escrow id", () => {
    const frame = [update({ escrow_id: "1" }), update({ escrow_id: "42" })].map((u) => JSON.stringify(u)).join("\n");
    assert.deepStrictEqual(parseRelayFrame(frame, "42").map((u) => u.escrow_id), ["42"]);
  });
});

describe("mergeEscrowUpdate", () => {
  test("creates an entry from scratch", () => {
    const merged = mergeEscrowUpdate(undefined, update({ payout_amount: "980" }));
    assert.deepStrictEqual(merged, {
      id: "42",
      status: "Funded",
      payoutAmount: "980",
      lastEventId: "evt-1",
      updatedAt: "2026-11-20T10:00:00Z",
    });
  });

  test("preserves unrelated fields from the cached record", () => {
    const prev: EscrowCacheEntry = { id: "42", status: "Funded", amount: 1000, recipient: "GABC" };
    const merged = mergeEscrowUpdate(prev, update({ event_id: "evt-2", status: "Disbursed" }));
    assert.strictEqual(merged.status, "Disbursed");
    assert.strictEqual((merged as EscrowCacheEntry).amount, 1000);
  });

  test("ignores duplicate events (returns same reference)", () => {
    const prev = mergeEscrowUpdate(undefined, update());
    assert.strictEqual(mergeEscrowUpdate(prev, update()), prev);
  });

  test("ignores out-of-order (older) updates", () => {
    const prev = mergeEscrowUpdate(undefined, update({ event_id: "new", timestamp: "2026-11-20T12:00:00Z", status: "Disbursed" }));
    const stale = mergeEscrowUpdate(prev, update({ event_id: "old", timestamp: "2026-11-20T11:00:00Z", status: "Funded" }));
    assert.strictEqual(stale, prev);
    assert.strictEqual(stale.status, "Disbursed");
  });
});

describe("applyEscrowUpdateToCache (real QueryClient)", () => {
  test("updates the detail query immediately", () => {
    const qc = new QueryClient();
    qc.setQueryData(escrowQueryKey("42"), { id: "42", status: "Funded", amount: 10 });
    applyEscrowUpdateToCache(qc, update({ event_id: "x", status: "Disputed" }));
    const entry = qc.getQueryData<EscrowCacheEntry>(escrowQueryKey("42"));
    assert.strictEqual(entry?.status, "Disputed");
    assert.strictEqual(entry?.amount, 10);
  });

  test("updates matching rows in list queries and leaves others untouched", () => {
    const qc = new QueryClient();
    const other = { id: "7", status: "Funded" };
    qc.setQueryData(["escrows", { page: 1 }], [{ id: "42", status: "Funded" }, other]);
    qc.setQueryData(["escrows", "summary"], { total: 2 });
    applyEscrowUpdateToCache(qc, update({ status: "Refunded" }));
    const list = qc.getQueryData<EscrowCacheEntry[]>(["escrows", { page: 1 }])!;
    assert.strictEqual(list[0].status, "Refunded");
    assert.strictEqual(list[1], other);
    assert.deepStrictEqual(qc.getQueryData(["escrows", "summary"]), { total: 2 });
  });

  test("does not replace list arrays when nothing matched", () => {
    const qc = new QueryClient();
    const rows = [{ id: "7", status: "Funded" }];
    qc.setQueryData(["escrows"], rows);
    applyEscrowUpdateToCache(qc, update());
    assert.strictEqual(qc.getQueryData(["escrows"]), rows);
  });
});

/** Deterministic in-memory WebSocket for exercising reconnect/backoff without timers. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  serverOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverMessage(data: unknown) {
    this.onmessage?.({ data });
  }
  serverDrop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

describe("EscrowSocketClient with fake socket", () => {
  const setup = (maxRetries?: number) => {
    FakeSocket.instances = [];
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const statuses: EscrowSocketStatus[] = [];
    const updates: EscrowUpdate[] = [];
    const client = new EscrowSocketClient({
      url: "ws://relay.test/ws",
      escrowId: "42",
      createSocket: (url) => new FakeSocket(url),
      backoff: { baseMs: 100, factor: 2, maxMs: 1000, jitter: 0 },
      maxRetries,
      schedule: (fn, ms) => {
        scheduled.push({ fn, ms });
        return scheduled.length;
      },
      cancel: () => undefined,
      onUpdate: (u) => updates.push(u),
      onStatusChange: (s) => statuses.push(s),
    });
    return { client, scheduled, statuses, updates };
  };

  test("subscribes on open and forwards updates", () => {
    const { client, statuses, updates } = setup();
    client.start();
    const sock = FakeSocket.instances[0];
    sock.serverOpen();
    assert.deepStrictEqual(sock.sent, [buildSubscribeMessage("42")]);
    sock.serverMessage(JSON.stringify(update()));
    assert.strictEqual(updates.length, 1);
    assert.deepStrictEqual(statuses.slice(0, 2), ["connecting", "open"]);
    client.stop();
  });

  test("reconnects with exponential backoff and resets after a successful open", () => {
    const { client, scheduled } = setup();
    client.start();
    FakeSocket.instances[0].serverDrop();
    assert.strictEqual(scheduled[0].ms, 100);
    scheduled[0].fn();
    FakeSocket.instances[1].serverDrop();
    assert.strictEqual(scheduled[1].ms, 200);
    scheduled[1].fn();
    FakeSocket.instances[2].serverDrop();
    assert.strictEqual(scheduled[2].ms, 400);
    scheduled[2].fn();
    FakeSocket.instances[3].serverOpen();
    assert.strictEqual(client.reconnectAttempts, 0);
    FakeSocket.instances[3].serverDrop();
    assert.strictEqual(scheduled[3].ms, 100, "backoff resets after a healthy connection");
    client.stop();
  });

  test("gives up after maxRetries consecutive failures", () => {
    const { client, scheduled, statuses } = setup(2);
    client.start();
    FakeSocket.instances[0].serverDrop();
    scheduled[0].fn();
    FakeSocket.instances[1].serverDrop();
    scheduled[1].fn();
    FakeSocket.instances[2].serverDrop();
    assert.strictEqual(scheduled.length, 2);
    assert.strictEqual(statuses.at(-1), "error");
  });

  test("stop() unsubscribes, closes, and suppresses reconnects", () => {
    const { client, scheduled } = setup();
    client.start();
    const sock = FakeSocket.instances[0];
    sock.serverOpen();
    client.stop();
    assert.strictEqual(sock.sent.at(-1), buildUnsubscribeMessage("42"));
    assert.ok(sock.closed);
    sock.serverDrop();
    assert.strictEqual(scheduled.length, 0);
  });

  test("ignores events from a superseded socket", () => {
    const { client, scheduled, updates } = setup();
    client.start();
    const first = FakeSocket.instances[0];
    const firstOnMessage = first.onmessage;
    first.serverDrop();
    scheduled[0].fn();
    firstOnMessage?.({ data: JSON.stringify(update()) });
    assert.strictEqual(updates.length, 0);
    client.stop();
  });

  test("rejects invalid escrow ids at construction", () => {
    assert.throws(
      () => new EscrowSocketClient({ url: "ws://x", escrowId: "bad id", onUpdate: () => undefined }),
      /Invalid escrow id/
    );
  });
});

describe("EscrowSocketClient against a mock WebSocket server", () => {
  const servers: WebSocketServer[] = [];
  after(() => servers.forEach((s) => s.close()));

  const startServer = async () => {
    const wss = new WebSocketServer({ port: 0 });
    servers.push(wss);
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const subscriptions: string[] = [];
    const connections: ServerSocket[] = [];
    wss.on("connection", (sock) => {
      connections.push(sock);
      sock.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.action === "subscribe") subscriptions.push(msg.channel);
      });
    });
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    return { wss, url, subscriptions, connections };
  };

  test("subscribes, receives batched updates, writes React Query cache, and reconnects after a drop", async () => {
    const server = await startServer();
    const qc = new QueryClient();
    qc.setQueryData(["escrows"], [{ id: "42", status: "Funded" }]);
    const statuses: EscrowSocketStatus[] = [];

    const client = new EscrowSocketClient({
      url: server.url,
      escrowId: "42",
      backoff: { baseMs: 20, maxMs: 100, jitter: 0 },
      onUpdate: (u) => applyEscrowUpdateToCache(qc, u),
      onStatusChange: (s) => statuses.push(s),
    });
    client.start();

    await waitFor(() => server.subscriptions.length === 1, 3000, "first subscription");
    assert.strictEqual(server.subscriptions[0], "subscribe:escrow:42");

    // Relay coalesces queued messages with '\n' — include an update for another escrow too.
    server.connections[0].send(
      [
        JSON.stringify(update({ escrow_id: "99", event_id: "other" })),
        JSON.stringify(update({ event_id: "e1", status: "Disbursed", payout_amount: "980" })),
      ].join("\n")
    );
    await waitFor(() => qc.getQueryData<EscrowCacheEntry>(escrowQueryKey("42"))?.status === "Disbursed", 3000, "cache update");
    assert.strictEqual(qc.getQueryData<EscrowCacheEntry[]>(["escrows"])![0].status, "Disbursed");
    assert.strictEqual(qc.getQueryData(escrowQueryKey("99")), undefined, "foreign escrow updates are ignored");

    // Simulate a connection drop → client must reconnect and resubscribe.
    server.connections[0].terminate();
    await waitFor(() => server.subscriptions.length === 2, 3000, "resubscription after drop");
    assert.ok(statuses.includes("reconnecting"));

    server.connections[1].send(JSON.stringify(update({ event_id: "e2", status: "Refunded", timestamp: "2026-11-20T11:00:00Z" })));
    await waitFor(() => qc.getQueryData<EscrowCacheEntry>(escrowQueryKey("42"))?.status === "Refunded", 3000, "post-reconnect update");

    client.stop();
    assert.strictEqual(statuses.at(-1), "closed");
  });

  test("keeps retrying with backoff while the server is unreachable, then connects once it is up", async () => {
    const probe = await startServer();
    const url = probe.url;
    const port = Number(new URL(url).port);
    await new Promise<void>((r) => probe.wss.close(() => r()));

    // Poll until the port is genuinely unreachable (connection refused),
    // so the client's first connection attempt fails immediately and
    // drives it into the reconnect/backoff path.
    const net = await import("node:net");
    let unreachable = false;
    for (let i = 0; i < 100 && !unreachable; i++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const sock = new net.Socket();
          sock.setTimeout(100);
          sock.once("connect", () => {
            sock.destroy();
            resolve();
          });
          sock.once("error", () => {
            sock.destroy();
            reject();
          });
          sock.once("timeout", () => {
            sock.destroy();
            reject();
          });
          sock.connect(port, "127.0.0.1");
        });
        // Port still reachable — wait and poll again
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        unreachable = true;
      }
    }
    assert.ok(unreachable, "test port should be unreachable before starting the client");

    const statuses: EscrowSocketStatus[] = [];
    const client = new EscrowSocketClient({
      url,
      escrowId: "7",
      backoff: { baseMs: 20, maxMs: 80, jitter: 0 },
      onUpdate: () => undefined,
      onStatusChange: (s) => statuses.push(s),
    });
    client.start();
    await waitFor(() => statuses.filter((s) => s === "reconnecting").length >= 2, 3000, "retry attempts");

    const revived = new WebSocketServer({ port });
    servers.push(revived);
    const subscribed = new Promise<string>((resolve) =>
      revived.on("connection", (sock) => sock.on("message", (raw) => resolve(JSON.parse(raw.toString()).channel)))
    );
    assert.strictEqual(await subscribed, "subscribe:escrow:7");
    await waitFor(() => statuses.includes("open"), 3000, "open status");
    client.stop();
  });
});
