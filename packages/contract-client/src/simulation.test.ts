import assert from "node:assert";
import { describe, test } from "node:test";
import {
  Account,
  Keypair,
  rpc,
  StrKey,
  SorobanDataBuilder,
  Transaction,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import {
  CreateEscrowSimulationError,
  EscrowGateClient,
  simulateCreateEscrow,
} from "./index";
import type {
  CreateEscrowParams,
  SimulateCreateEscrowOptions,
} from "./simulation";

const contractId =
  "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT";
const config = {
  contractId,
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

function params(overrides: Partial<CreateEscrowParams> = {}): CreateEscrowParams {
  return {
    payer: Keypair.random().publicKey(),
    beneficiary: Keypair.random().publicKey(),
    token: contractId,
    amount: 123_456n,
    profileHashHex: "ab".repeat(32),
    lockDurationSeconds: 3_600n,
    config,
    ...overrides,
  };
}

function successfulResponse(
  minResourceFee: string,
  latestLedger: unknown = 500,
  additional: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "simulation-test",
    latestLedger,
    events: [],
    _parsed: true,
    minResourceFee,
    transactionData: new SorobanDataBuilder().setResourceFee(minResourceFee),
    result: {
      auth: [],
      retval: nativeToScVal(7n, { type: "u64" }),
    },
    ...additional,
  };
}

function mockServer(
  input: CreateEscrowParams,
  response: unknown | ((transaction: Transaction) => unknown),
  counters: { getAccount?: number; simulate?: number } = {}
): Pick<rpc.Server, "getAccount" | "simulateTransaction"> {
  return {
    getAccount: async (address: string) => {
      counters.getAccount = (counters.getAccount ?? 0) + 1;
      assert.strictEqual(address, input.payer);
      return new Account(address, "41");
    },
    simulateTransaction: async (transaction: Transaction) => {
      counters.simulate = (counters.simulate ?? 0) + 1;
      return (typeof response === "function"
        ? response(transaction)
        : response) as rpc.Api.SimulateTransactionResponse;
    },
  };
}

function options(
  server: Pick<rpc.Server, "getAccount" | "simulateTransaction">
): SimulateCreateEscrowOptions {
  return { server };
}

function diagnosticEvent(contractId: string): Record<string, unknown> {
  return {
    event: {
      contractId: { value: StrKey.decodeContract(contractId) },
    },
  };
}

describe("simulateCreateEscrow", () => {
  test("builds and simulates the existing escrow operation without signing or submitting", async () => {
    const input = params();
    const counters = { getAccount: 0, simulate: 0 };
    let sentTransaction: Transaction | undefined;
    let submitCalls = 0;
    const server = {
      ...mockServer(input, (transaction: Transaction) => {
        sentTransaction = transaction;
        return successfulResponse("17293");
      }, counters),
      sendTransaction: async () => {
        submitCalls += 1;
        throw new Error("sendTransaction must not be called");
      },
    };

    const result = await simulateCreateEscrow(input, options(server));

    assert.deepStrictEqual(result, {
      estimatedResourceFeeStroops: 17_293n,
      estimatedTransactionFeeStroops: 17_393n,
      latestLedger: 500,
      requiresRestore: false,
    });
    assert.strictEqual(counters.getAccount, 1);
    assert.strictEqual(counters.simulate, 1);
    assert.strictEqual(submitCalls, 0);
    assert.ok(sentTransaction);
    assert.strictEqual(sentTransaction.source, input.payer);
    assert.strictEqual(sentTransaction.sequence, "42");
    assert.strictEqual(sentTransaction.signatures.length, 0);
    assert.strictEqual(sentTransaction.operations.length, 1);
    assert.strictEqual(sentTransaction.operations[0].type, "invokeHostFunction");
  });

  test("preserves large integer fee values exactly within Stellar's fee bound", async () => {
    const input = params();
    const fee = "4294967195";
    const result = await simulateCreateEscrow(
      input,
      options(mockServer(input, successfulResponse(fee)))
    );

    assert.strictEqual(result.estimatedResourceFeeStroops, BigInt(fee));
    assert.strictEqual(result.estimatedTransactionFeeStroops, BigInt(fee) + 100n);
  });

  test("rejects a resource fee that cannot fit the assembled Stellar transaction fee", async () => {
    const input = params();
    await assert.rejects(
      simulateCreateEscrow(
        input,
        options(mockServer(input, successfulResponse("9007199254740993")))
      ),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.kind, "invalid_response");
        assert.match(caught.message, /maximum uint32 value/);
        return true;
      }
    );
  });

  test("reports restoration costs separately when RPC requires a restore transaction", async () => {
    const input = params();
    const response = successfulResponse("500", 600, {
      restorePreamble: {
        minResourceFee: "2300",
        transactionData: new SorobanDataBuilder().setResourceFee("2300"),
      },
    });

    const result = await simulateCreateEscrow(
      input,
      options(mockServer(input, response))
    );

    assert.strictEqual(result.requiresRestore, true);
    assert.strictEqual(result.estimatedRestoreResourceFeeStroops, 2300n);
    assert.strictEqual(result.estimatedResourceFeeStroops, 500n);
    assert.strictEqual(result.estimatedTransactionFeeStroops, 600n);
  });

  test("rejects a malformed restoration preamble", async () => {
    const input = params();
    const response = successfulResponse("100", 600, {
      restorePreamble: { minResourceFee: "200" },
    });

    await assert.rejects(
      simulateCreateEscrow(input, options(mockServer(input, response))),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.kind, "invalid_response");
        assert.match(caught.message, /malformed restorePreamble/);
        return true;
      }
    );
  });

  test("does not mislabel latestLedger as a minimum ledger sequence", async () => {
    const input = params();
    const response = successfulResponse("25");
    delete response.latestLedger;
    const result = await simulateCreateEscrow(
      input,
      options(mockServer(input, response))
    );

    assert.strictEqual(result.latestLedger, undefined);
    assert.strictEqual("minimumLedgerSequence" in result, false);
  });

  test("maps a known Soroban escrow contract error to a readable diagnostic", async () => {
    const input = params();
    const error = {
      id: "simulation-test",
      latestLedger: 500,
      events: [diagnosticEvent(input.config.contractId)],
      _parsed: true,
      error: "HostError: Error(Contract, #11)",
    };

    await assert.rejects(
      simulateCreateEscrow(input, options(mockServer(input, error))),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.kind, "simulation");
        assert.strictEqual(caught.contractErrorCode, 11);
        assert.strictEqual(caught.contractErrorName, "TokenNotWhitelisted");
        assert.match(caught.message, /token is not on the escrow contract whitelist/i);
        return true;
      }
    );
  });

  test("does not apply an escrow error description to a nested contract error", async () => {
    const input = params();
    const nestedTokenContract =
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const response = {
      id: "simulation-test",
      latestLedger: 500,
      events: [diagnosticEvent(nestedTokenContract)],
      _parsed: true,
      error: "HostError: Error(Contract, #11)",
    };

    await assert.rejects(
      simulateCreateEscrow(input, options(mockServer(input, response))),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.contractErrorCode, 11);
        assert.strictEqual(caught.contractErrorName, undefined);
        assert.match(caught.message, /did not confirm that the Anchor Gate contract raised it/);
        return true;
      }
    );
  });

  test("retains an unknown structured contract error code with a clear fallback", async () => {
    const input = params();
    const response = {
      id: "simulation-test",
      latestLedger: 500,
      events: [],
      _parsed: true,
      error: "HostError: Error(Contract, #999)",
    };

    await assert.rejects(
      simulateCreateEscrow(input, options(mockServer(input, response))),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.contractErrorCode, 999);
        assert.strictEqual(caught.contractErrorName, undefined);
        assert.match(caught.message, /unknown contract error #999/i);
        return true;
      }
    );
  });

  test("does not interpret an unrelated RPC error number as a contract error", async () => {
    const input = params();
    const response = {
      id: "simulation-test",
      latestLedger: 500,
      events: [],
      _parsed: true,
      error: "JSON-RPC error -32602: invalid request",
    };

    await assert.rejects(
      simulateCreateEscrow(input, options(mockServer(input, response))),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.kind, "simulation");
        assert.strictEqual(caught.contractErrorCode, undefined);
        assert.match(caught.message, /JSON-RPC error -32602/);
        return true;
      }
    );
  });

  test("preserves structured RPC codes while redacting credential-bearing details", async () => {
    const input = params();
    const server = {
      getAccount: async (address: string) => new Account(address, "41"),
      simulateTransaction: async () => {
        throw {
          code: -32603,
          message: "upstream failure for https://rpc.example/secret?token=private",
        };
      },
    };

    await assert.rejects(
      simulateCreateEscrow(input, options(server)),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.kind, "rpc");
        assert.strictEqual(caught.rpcCode, -32603);
        assert.match(caught.message, /RPC error -32603/);
        assert.doesNotMatch(caught.message, /private|secret/);
        return true;
      }
    );
  });

  test("reports payer account lookup failures as RPC errors", async () => {
    const input = params();
    const server = {
      getAccount: async () => {
        throw new Error("Account lookup timed out");
      },
      simulateTransaction: async () =>
        successfulResponse("100") as unknown as rpc.Api.SimulateTransactionResponse,
    };

    await assert.rejects(
      simulateCreateEscrow(input, options(server)),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.kind, "rpc");
        assert.match(caught.message, /fetching the payer account sequence/);
        assert.match(caught.message, /timed out/);
        return true;
      }
    );
  });

  test("rejects missing fee information instead of returning a misleading estimate", async () => {
    const input = params();
    const response = successfulResponse("100");
    delete response.minResourceFee;

    await assert.rejects(
      simulateCreateEscrow(input, options(mockServer(input, response))),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.kind, "invalid_response");
        assert.match(caught.message, /missing minResourceFee/);
        return true;
      }
    );
  });

  test("rejects malformed resource fee strings", async () => {
    const input = params();
    const response = successfulResponse("100");
    response.minResourceFee = "not-a-fee";
    await assert.rejects(
      simulateCreateEscrow(
        input,
        options(mockServer(input, response))
      ),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.kind, "invalid_response");
        assert.match(caught.message, /invalid minResourceFee/);
        return true;
      }
    );
  });

  test("rejects an unexpected RPC response structure", async () => {
    const input = params();
    await assert.rejects(
      simulateCreateEscrow(
        input,
        options(mockServer(input, { status: "unexpected" }))
      ),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.kind, "invalid_response");
        assert.match(caught.message, /unexpected response structure/);
        return true;
      }
    );
  });

  test("reports a malformed ledger value as an invalid response", async () => {
    const input = params();
    await assert.rejects(
      simulateCreateEscrow(
        input,
        options(mockServer(input, successfulResponse("100", Number.MAX_SAFE_INTEGER + 1)))
      ),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.kind, "invalid_response");
        assert.match(caught.message, /invalid latestLedger/);
        return true;
      }
    );
  });

  test("reports RPC connectivity failures and timeouts with a stable error category", async () => {
    const input = params();
    const server = {
      getAccount: async (address: string) => new Account(address, "41"),
      simulateTransaction: async () => {
        throw new Error(
          "Request timeout while calling https://rpc.example/secret-path?token=private"
        );
      },
    };

    await assert.rejects(
      simulateCreateEscrow(input, options(server)),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.kind, "rpc");
        assert.match(caught.message, /timeout/i);
        assert.doesNotMatch(caught.message, /private|secret-path/);
        return true;
      }
    );
  });

  test("rejects invalid escrow parameters before making an RPC request", async () => {
    const input = params({ amount: 0n });
    const counters = { getAccount: 0, simulate: 0 };

    await assert.rejects(
      simulateCreateEscrow(
        input,
        options(mockServer(input, successfulResponse("1"), counters))
      ),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.kind, "invalid_input");
        assert.match(caught.message, /Amount must be greater than zero/);
        return true;
      }
    );
    assert.strictEqual(counters.getAccount, 0);
    assert.strictEqual(counters.simulate, 0);
  });

  test("wraps unexpected SDK assembly exceptions as malformed response diagnostics", async () => {
    const input = params();
    const response = successfulResponse("100");
    response.transactionData = {
      build: () => {
        throw new Error("unexpected builder failure");
      },
    };

    await assert.rejects(
      simulateCreateEscrow(input, options(mockServer(input, response))),
      (caught: unknown) => {
        assert.ok(caught instanceof CreateEscrowSimulationError);
        assert.strictEqual(caught.kind, "invalid_response");
        assert.match(caught.message, /could not assemble/);
        assert.match(caught.message, /unexpected builder failure/);
        return true;
      }
    );
  });

  test("keeps the existing escrow builder public API available", () => {
    const input = params();
    const client = new EscrowGateClient(input.config);
    const args = client.buildCreateEscrowTx(input);
    const operation = client.buildOperation(
      "create_escrow",
      args
    );
    assert.strictEqual(args.length, 6);
    assert.ok(operation);
  });
});
