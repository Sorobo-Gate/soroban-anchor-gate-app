import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import {
  EscrowEventStreamError,
  EscrowGateClient,
  type ClientConfig,
} from "./index";

const contractId =
  "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT";
const config: ClientConfig = {
  contractId,
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};
const escrowId = 42n;
const otherEscrowId = 43n;
const payer = Keypair.random().publicKey();
const beneficiary = Keypair.random().publicKey();
const token = Keypair.random().publicKey();
const profileHash = Uint8Array.from({ length: 32 }, (_, index) => index);
const commitmentHash = Uint8Array.from(
  { length: 32 },
  (_, index) => 255 - index
);
const contract = new Contract(contractId);

function sc(value: unknown, type: string): xdr.ScVal {
  return nativeToScVal(value, { type } as never);
}

function tuple(...values: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(values);
}

function event(
  name: string,
  id: bigint,
  value: xdr.ScVal,
  options: {
    eventId?: string;
    ledger?: number;
    txHash?: string;
    transactionIndex?: number;
    operationIndex?: number;
    extraTopics?: xdr.ScVal[];
    contractId?: string;
  } = {}
): rpc.Api.EventResponse {
  return {
    id: options.eventId ?? `event-${name}-${id}-${options.operationIndex ?? 0}`,
    type: "contract",
    ledger: options.ledger ?? 11,
    ledgerClosedAt: "2026-11-21T00:00:00Z",
    transactionIndex: options.transactionIndex ?? 0,
    operationIndex: options.operationIndex ?? 0,
    inSuccessfulContractCall: true,
    txHash: options.txHash ?? "a".repeat(64),
    contractId: new Contract(options.contractId ?? contractId),
    topic: [
      sc(name, "symbol"),
      name === "ClawbackHandled"
        ? sc(token, "address")
        : sc(id, "u64"),
      ...(options.extraTopics ?? []),
    ],
    value,
  };
}

function createdEvent(
  id = escrowId,
  options: Parameters<typeof event>[3] = {}
): rpc.Api.EventResponse {
  return event(
    "created",
    id,
    tuple(
      sc(payer, "address"),
      sc(125_000n, "i128"),
      sc(profileHash, "bytes")
    ),
    options
  );
}

function response(
  events: rpc.Api.EventResponse[],
  latestLedger: number,
  cursor = `cursor-${latestLedger}`
): rpc.Api.GetEventsResponse {
  return {
    events,
    latestLedger,
    oldestLedger: 1,
    latestLedgerCloseTime: "2026-11-21T00:00:00Z",
    oldestLedgerCloseTime: "2026-11-20T00:00:00Z",
    cursor,
  };
}

type RpcStub = Pick<rpc.Server, "getEvents" | "getLatestLedger">;

function stub(
  latest: () => number | Promise<number>,
  getEvents: (
    request: rpc.Api.GetEventsRequest
  ) => rpc.Api.GetEventsResponse | Promise<rpc.Api.GetEventsResponse>
): RpcStub {
  return {
    getLatestLedger: async () => ({
      sequence: await latest(),
    }) as rpc.Api.GetLatestLedgerResponse,
    getEvents: async (request) => getEvents(request),
  };
}

describe("EscrowGateClient.watchEscrow", () => {
  test("decodes contract escrow events, retains metadata, and filters other escrows", async () => {
    const splitTopic = sc(0, "u32");
    const events = [
      createdEvent(),
      event(
        "disbursed",
        escrowId,
        tuple(sc(profileHash, "bytes"), sc(100_000n, "i128")),
        { eventId: "event-disbursed", operationIndex: 1 }
      ),
      event(
        "split_disb",
        escrowId,
        tuple(
          sc(beneficiary, "address"),
          sc(60_000n, "i128"),
          sc(commitmentHash, "bytes")
        ),
        {
          eventId: "event-split-0",
          txHash: "b".repeat(64),
          operationIndex: 2,
          extraTopics: [splitTopic],
        }
      ),
      event(
        "split_disb",
        escrowId,
        tuple(
          sc(payer, "address"),
          sc(40_000n, "i128"),
          sc(commitmentHash, "bytes")
        ),
        {
          eventId: "event-split-1",
          txHash: "b".repeat(64),
          operationIndex: 2,
          extraTopics: [sc(1, "u32")],
        }
      ),
      event("refunded", escrowId, sc(500n, "i128")),
      event(
        "keeper_refund",
        escrowId,
        tuple(
          sc(beneficiary, "address"),
          sc(25n, "i128"),
          sc(payer, "address"),
          sc(475n, "i128")
        )
      ),
      event(
        "dispute_resolved",
        escrowId,
        tuple(sc(30n, "i128"), sc(70n, "i128"))
      ),
      event(
        "ClawbackHandled",
        0n,
        tuple(sc(escrowId, "u64"), sc(10n, "i128"))
      ),
      event(
        "disbursed",
        otherEscrowId,
        tuple(sc(profileHash, "bytes"), sc(10n, "i128")),
        { eventId: "other-escrow-event" }
      ),
      event("whitelist", escrowId, sc(true, "bool")),
      event("created", escrowId, sc(true, "bool"), {
        eventId: "malformed-created-payload",
      }),
      event("refunded", escrowId, sc(-1n, "i128"), {
        eventId: "negative-refund-payload",
      }),
      createdEvent(escrowId, { eventId: "" }),
      event("disbursed", escrowId, sc(1n, "i128"), {
        eventId: "other-contract-event",
        contractId: StrKey.encodeContract(Buffer.alloc(32, 1)),
      }),
    ];
    let calls = 0;
    let firstRequest: rpc.Api.GetEventsRequest | undefined;
    const server = stub(
      () => (calls++ === 0 ? 10 : 11),
      (request) => {
        firstRequest ??= request;
        return response(events, 11);
      }
    );
    const iterator = new EscrowGateClient(config).watchEscrow(escrowId, {
      server,
      pollIntervalMs: 1,
    });
    const observed = [];
    for await (const item of iterator) {
      observed.push(item);
      if (observed.length === 8) break;
    }

    assert.deepEqual(
      observed.map((item) => item.type),
      [
        "created",
        "disbursed",
        "split_disb",
        "split_disb",
        "refunded",
        "keeper_refund",
        "dispute_resolved",
        "clawback_handled",
      ]
    );
    assert.equal(observed[0].escrowId, escrowId);
    assert.equal(observed[0].metadata.eventId, "event-created-42-0");
    assert.equal(observed[0].metadata.ledger, 11);
    assert.equal(observed[0].metadata.txHash, "a".repeat(64));
    assert.equal(observed[0].type === "created" && observed[0].amount, 125_000n);
    assert.equal(
      observed[0].type === "created" && observed[0].profileHashHex,
      Buffer.from(profileHash).toString("hex")
    );
    assert.deepEqual(
      observed.filter((item) => item.type === "split_disb").map((item) => item.index),
      [0, 1]
    );
    assert.equal(
      observed[7].type === "clawback_handled" && observed[7].deficit,
      10n
    );

    assert.ok(firstRequest && "startLedger" in firstRequest);
    if (firstRequest && "startLedger" in firstRequest) {
      assert.equal(firstRequest.startLedger, 11);
      assert.equal(firstRequest.endLedger, 12);
      assert.ok(firstRequest.filters.every((filter) => filter.contractIds?.[0] === contractId));
      assert.equal(firstRequest.filters.length, 3);
      assert.equal(firstRequest.filters[0].topics?.[0].length, 5);
      assert.equal(firstRequest.filters[1].topics?.length, 3);
    }
  });

  test("paginates full event pages without collapsing events in one transaction", async () => {
    const sameTx = "c".repeat(64);
    const entries = [
      createdEvent(escrowId, { eventId: "page-1", txHash: sameTx }),
      event("refunded", escrowId, sc(1n, "i128"), {
        eventId: "page-2",
        txHash: sameTx,
        operationIndex: 0,
      }),
      event("disbursed", escrowId, tuple(sc(profileHash, "bytes"), sc(2n, "i128")), {
        eventId: "page-3",
        txHash: sameTx,
        operationIndex: 0,
      }),
    ];
    const requests: rpc.Api.GetEventsRequest[] = [];
    const server = stub(
      (() => {
        let count = 0;
        return () => (count++ === 0 ? 10 : 11);
      })(),
      (request) => {
        requests.push(request);
        if (requests.length === 1) return response(entries.slice(0, 2), 11, "page-cursor");
        return response(entries.slice(2), 11, "page-end");
      }
    );
    const iterator = new EscrowGateClient(config).watchEscrow(escrowId, {
      server,
      pageLimit: 2,
      pollIntervalMs: 1,
    });
    const observed = [await iterator.next(), await iterator.next()];
    assert.equal(requests.length, 1, "the next RPC page waits for consumer demand");
    observed.push(await iterator.next());
    await iterator.return?.();

    assert.deepEqual(
      observed.map((result) => result.value?.type),
      ["created", "refunded", "disbursed"]
    );
    assert.equal(requests.length, 2);
    assert.ok("startLedger" in requests[0]);
    assert.ok("cursor" in requests[1]);
    if ("cursor" in requests[1]) assert.equal(requests[1].cursor, "page-cursor");
  });

  test("retries a transient RPC failure without advancing the ledger cursor", async () => {
    let latestCalls = 0;
    let eventCalls = 0;
    const starts: number[] = [];
    const server = stub(
      () => (latestCalls++ === 0 ? 10 : 11),
      (request) => {
        if (typeof request.startLedger === "number") starts.push(request.startLedger);
        eventCalls += 1;
        if (eventCalls === 1) {
          throw Object.assign(new Error("RPC rate limit"), { status: 429 });
        }
        return response([createdEvent()], 11);
      }
    );
    const iterator = new EscrowGateClient(config).watchEscrow(escrowId, {
      server,
      pollIntervalMs: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2,
    });

    const result = await iterator.next();
    await iterator.return?.();
    assert.equal(result.value?.type, "created");
    assert.equal(eventCalls, 2);
    assert.deepEqual(starts, [11, 11]);
  });

  test("retries a failed continuation page without duplicate delivery", async () => {
    let latestCalls = 0;
    let pageCalls = 0;
    const duplicate = createdEvent(escrowId, { eventId: "same-tx-event" });
    const second = event("refunded", escrowId, sc(5n, "i128"), {
      eventId: "second-tx-event",
    });
    const server = stub(
      () => (latestCalls++ === 0 ? 10 : 11),
      (request) => {
        pageCalls += 1;
        if ("startLedger" in request) return response([duplicate], 11, "after-first");
        if (pageCalls === 2) {
          throw Object.assign(new Error("temporary connection reset"), {
            code: "ECONNRESET",
          });
        }
        return response([second], 11, "after-second");
      }
    );
    const iterator = new EscrowGateClient(config).watchEscrow(escrowId, {
      server,
      pageLimit: 1,
      pollIntervalMs: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2,
    });

    const first = await iterator.next();
    const next = await iterator.next();
    await iterator.return?.();
    assert.equal(first.value?.type, "created");
    assert.equal(next.value?.type, "refunded");
    assert.equal(pageCalls, 3);
  });

  test("restarts an expired pagination cursor from the ledger range", async () => {
    let latestCalls = 0;
    const requests: rpc.Api.GetEventsRequest[] = [];
    const firstEvent = createdEvent(escrowId, { eventId: "replayed-page-event" });
    const secondEvent = event("refunded", escrowId, sc(7n, "i128"), {
      eventId: "after-restart-event",
    });
    const server = stub(
      () => (latestCalls++ === 0 ? 10 : 11),
      (request) => {
        requests.push(request);
        if ("cursor" in request) {
          if (requests.length === 2) {
            throw Object.assign(new Error("cursor has expired"), {
              code: -32602,
            });
          }
          return response([secondEvent], 11, "recovered-end");
        }
        if (requests.length === 1) return response([firstEvent], 11, "expired-cursor");
        if (requests.length === 3) {
          return response([firstEvent], 11, "recovered-cursor");
        }
        return response([secondEvent], 11, "recovered-end");
      }
    );
    const iterator = new EscrowGateClient(config).watchEscrow(escrowId, {
      server,
      pageLimit: 1,
      pollIntervalMs: 1,
    });

    const first = await iterator.next();
    const second = await iterator.next();
    await iterator.return?.();
    assert.equal(first.value?.metadata.eventId, "replayed-page-event");
    assert.equal(second.value?.metadata.eventId, "after-restart-event");
    assert.equal(requests.length, 4);
    assert.ok("startLedger" in requests[0]);
    assert.ok("cursor" in requests[1]);
    assert.ok("startLedger" in requests[2]);
    assert.ok("cursor" in requests[3]);
  });

  test("overlaps the last completed ledger and suppresses replayed events", async () => {
    let latestCalls = 0;
    let eventCalls = 0;
    const original = createdEvent(escrowId, { eventId: "ledger-11-event", ledger: 11 });
    const following = event("refunded", escrowId, sc(5n, "i128"), {
      eventId: "ledger-12-event",
      ledger: 12,
    });
    const ranges: Array<[number, number | undefined]> = [];
    const server = stub(
      () => {
        const call = latestCalls++;
        return call === 0 ? 10 : call === 1 ? 11 : 12;
      },
      (request) => {
        eventCalls += 1;
        if (typeof request.startLedger === "number") {
          ranges.push([request.startLedger, request.endLedger]);
        }
        return eventCalls === 1
          ? response([original], 11)
          : response([original, following], 12);
      }
    );
    const iterator = new EscrowGateClient(config).watchEscrow(escrowId, {
      server,
      pollIntervalMs: 1,
    });

    const first = await iterator.next();
    const second = await iterator.next();
    await iterator.return?.();
    assert.equal(first.value?.metadata.eventId, "ledger-11-event");
    assert.equal(second.value?.metadata.eventId, "ledger-12-event");
    assert.deepEqual(ranges, [
      [11, 12],
      [11, 13],
    ]);
  });

  test("advances after an empty result and catches events in a later ledger", async () => {
    let latestCalls = 0;
    let eventCalls = 0;
    const starts: number[] = [];
    const server = stub(
      () => {
        const call = latestCalls++;
        return call < 2 ? 10 : call === 2 ? 11 : 12;
      },
      (request) => {
        eventCalls += 1;
        if (typeof request.startLedger === "number") starts.push(request.startLedger);
        return eventCalls === 1
          ? response([], 11)
          : response([createdEvent(escrowId, { ledger: 12 })], 12);
      }
    );
    const iterator = new EscrowGateClient(config).watchEscrow(escrowId, {
      server,
      pollIntervalMs: 1,
    });

    const result = await iterator.next();
    await iterator.return?.();
    assert.equal(result.value?.metadata.ledger, 12);
    assert.deepEqual(starts, [11, 11]);
  });

  test("surfaces permanent RPC errors and malformed responses", async () => {
    let latestCalls = 0;
    const permanent = stub(
      () => (latestCalls++ === 0 ? 10 : 11),
      () => {
        throw Object.assign(new Error("unsupported filter syntax"), {
          code: -32000,
        });
      }
    );
    const permanentIterator = new EscrowGateClient(config).watchEscrow(escrowId, {
      server: permanent,
      pollIntervalMs: 1,
    });
    await assert.rejects(permanentIterator.next(), (error: unknown) => {
      assert.ok(error instanceof EscrowEventStreamError);
      assert.equal(error.kind, "rpc");
      return true;
    });

    let malformedLatestCalls = 0;
    const malformed = stub(
      () => (malformedLatestCalls++ === 0 ? 10 : 11),
      () => ({ ...response([], 11), events: null }) as never
    );
    const malformedIterator = new EscrowGateClient(config).watchEscrow(
      escrowId,
      { server: malformed, pollIntervalMs: 1 }
    );
    await assert.rejects(malformedIterator.next(), (error: unknown) => {
      assert.ok(error instanceof EscrowEventStreamError);
      assert.equal(error.kind, "invalid_response");
      return true;
    });
  });

  test("rejects a full page when the RPC fails to provide an advancing cursor", async () => {
    let latestCalls = 0;
    const server = stub(
      () => (latestCalls++ === 0 ? 10 : 11),
      () => response([createdEvent()], 11, "")
    );
    const iterator = new EscrowGateClient(config).watchEscrow(escrowId, {
      server,
      pageLimit: 1,
      pollIntervalMs: 1,
    });
    const eventResult = await iterator.next();
    assert.equal(eventResult.value?.type, "created");
    await assert.rejects(iterator.next(), (error: unknown) => {
      assert.ok(error instanceof EscrowEventStreamError);
      assert.equal(error.kind, "invalid_response");
      return true;
    });
  });

  test("reports an RPC retention gap instead of silently skipping history", async () => {
    let latestCalls = 0;
    const server = stub(
      () => (latestCalls++ === 0 ? 10 : 20),
      () => ({ ...response([], 20), oldestLedger: 12 })
    );
    const iterator = new EscrowGateClient(config).watchEscrow(escrowId, {
      server,
      pollIntervalMs: 1,
    });
    await assert.rejects(iterator.next(), (error: unknown) => {
      assert.ok(error instanceof EscrowEventStreamError);
      assert.equal(error.kind, "retention_gap");
      return true;
    });
  });

  test("validates contract u64 IDs and polling options synchronously", () => {
    const instance = new EscrowGateClient(config);
    assert.throws(() => instance.watchEscrow(0n), RangeError);
    assert.throws(() => instance.watchEscrow(-1n), RangeError);
    assert.throws(() => instance.watchEscrow(1n << 64n), RangeError);
    assert.throws(
      () => instance.watchEscrow(1n, { pageLimit: 1_001 }),
      RangeError
    );
  });

  test("return cancels a pending next call and prevents later polling", async () => {
    let latestCalls = 0;
    const server = stub(
      () => {
        latestCalls += 1;
        return 10;
      },
      () => response([], 10)
    );
    const iterator = new EscrowGateClient(config).watchEscrow(escrowId, {
      server,
      pollIntervalMs: 20,
    });
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 1));
    const stopped = await iterator.return?.();
    const nextResult = await pending;
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(stopped?.done, true);
    assert.equal(nextResult.done, true);
    assert.equal(latestCalls, 1);
  });

  test("separate iterators keep independent ledger cursors", async () => {
    let latestCalls = 0;
    const server = stub(
      () => {
        latestCalls += 1;
        return 10;
      },
      () => response([], 10)
    );
    const first = new EscrowGateClient(config).watchEscrow(escrowId, {
      server,
      pollIntervalMs: 20,
    });
    const second = new EscrowGateClient(config).watchEscrow(escrowId, {
      server,
      pollIntervalMs: 20,
    });
    const firstPending = first.next();
    const secondPending = second.next();
    await new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.all([first.return?.(), second.return?.()]);
    await Promise.all([firstPending, secondPending]);

    assert.equal(latestCalls, 2);
  });
});
