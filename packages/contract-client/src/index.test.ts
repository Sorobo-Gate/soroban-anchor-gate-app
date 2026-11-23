import assert from "node:assert";
import { test, describe } from "node:test";
import {
  EscrowGateClient,
  EscrowContractState,
  EscrowError,
  calculateDisputeSplit,
  computeProfileHash,
  disputeRecordToScVal,
  escrowToScVal,
  feeConfigToScVal,
  formatTokenAmount,
  fromStroops,
  getAnchorExchangeQuote,
  isValidAddress,
  parseTokenAmount,
  scValToDisputeRecord,
  scValToEscrow,
  scValToFeeConfig,
  toStroops,
  validateClientConfig,
  validateProfileHashHex,
} from "./index";
import {
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

describe("EscrowGateClient & SDK Helpers", () => {
  const validContractId =
    "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT";
  const validAdmin = Keypair.random().publicKey();
  const validTreasury = Keypair.random().publicKey();
  const validPayer = Keypair.random().publicKey();
  const validBeneficiary = Keypair.random().publicKey();
  const validToken = Keypair.random().publicKey();
  const validAnchor = Keypair.random().publicKey();
  const validRpcUrl = "https://soroban-testnet.stellar.org";
  const validPassphrase = "Test SDF Network ; September 2015";

  const validConfig = {
    contractId: validContractId,
    rpcUrl: validRpcUrl,
    networkPassphrase: validPassphrase,
  };

  test("validateClientConfig passes for valid config", () => {
    assert.doesNotThrow(() => validateClientConfig(validConfig));
  });

  test("validateClientConfig throws on invalid contract ID or empty passphrase", () => {
    assert.throws(() =>
      validateClientConfig({ ...validConfig, contractId: "INVALID" })
    );
    assert.throws(() =>
      validateClientConfig({ ...validConfig, networkPassphrase: "" })
    );
    assert.throws(() =>
      validateClientConfig({ ...validConfig, rpcUrl: "invalid-url" })
    );
  });

  test("isValidAddress validates G-addresses and C-addresses", () => {
    assert.strictEqual(isValidAddress(validPayer), true);
    assert.strictEqual(isValidAddress(validContractId), true);
    assert.strictEqual(isValidAddress("INVALID_ADDRESS"), false);
  });

  test("computeProfileHash produces deterministic 32-byte hex hash", () => {
    const rawRouting = "IBAN: DE89370400440532013000";
    const hash1 = computeProfileHash(rawRouting);
    const hash2 = computeProfileHash(rawRouting);

    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 64);
    assert.doesNotThrow(() => validateProfileHashHex(hash1));
  });

  test("validateProfileHashHex rejects invalid hash length or non-hex string", () => {
    assert.throws(() => validateProfileHashHex("12345"));
    assert.throws(() => validateProfileHashHex("z".repeat(64)));
  });

  test("integer-safe token amount parsing and formatting", () => {
    const parsed = parseTokenAmount("100.5", 7);
    assert.strictEqual(parsed, 1005000000n);

    const formatted = formatTokenAmount(1005000000n, 7);
    assert.strictEqual(formatted, "100.5");

    assert.throws(() => parseTokenAmount("100.12345678", 7));
    assert.throws(() => parseTokenAmount("-50", 7));
  });

  test("buildCreateEscrowTx encodes correct argument types and order", () => {
    const client = new EscrowGateClient(validConfig);
    const profileHashHex = computeProfileHash("DE89370400440532013000");

    const args = client.buildCreateEscrowTx({
      payer: validPayer,
      beneficiary: validBeneficiary,
      token: validToken,
      amount: 500000000n,
      profileHashHex,
      lockDurationSeconds: 86400n,
    });

    assert.strictEqual(args.length, 6);
    assert.strictEqual(scValToNative(args[0]), validPayer);
    assert.strictEqual(scValToNative(args[1]), validBeneficiary);
    assert.strictEqual(scValToNative(args[2]), validToken);
    assert.strictEqual(scValToNative(args[3]), 500000000n);
    assert.strictEqual(
      Buffer.from(scValToNative(args[4]) as Uint8Array).toString("hex"),
      profileHashHex
    );
    assert.strictEqual(scValToNative(args[5]), 86400n);
  });

  test("buildReleaseToAnchorTx encodes u64 escrow_id and addresses", () => {
    const client = new EscrowGateClient(validConfig);
    const args = client.buildReleaseToAnchorTx({
      escrowId: 42n,
      caller: validPayer,
      anchorDisbursementAddress: validAnchor,
    });

    assert.strictEqual(args.length, 3);
    assert.strictEqual(scValToNative(args[0]), 42n);
    assert.strictEqual(scValToNative(args[1]), validPayer);
    assert.strictEqual(scValToNative(args[2]), validAnchor);
  });

  test("buildRefundTx encodes u64 escrow_id", () => {
    const client = new EscrowGateClient(validConfig);
    const args = client.buildRefundTx(100n);

    assert.strictEqual(args.length, 1);
    assert.strictEqual(scValToNative(args[0]), 100n);
  });

  test("buildInitTx encodes admin, treasury, and fee_bps with contract parity", () => {
    const client = new EscrowGateClient(validConfig);
    const args = client.buildInitTx(validAdmin, validTreasury, 200);

    assert.strictEqual(args.length, 3);
    assert.strictEqual(scValToNative(args[0]), validAdmin);
    assert.strictEqual(scValToNative(args[1]), validTreasury);
    assert.strictEqual(scValToNative(args[2]), 200);

    // Rejects fee_bps > 1000 (contract InvalidBps)
    assert.throws(() => client.buildInitTx(validAdmin, validTreasury, 1001));
    // Rejects negative fee_bps
    assert.throws(() => client.buildInitTx(validAdmin, validTreasury, -1));
    // Rejects non-integer fee_bps
    assert.throws(() => client.buildInitTx(validAdmin, validTreasury, 2.5));
    // Rejects invalid address
    assert.throws(() => client.buildInitTx("INVALID", validTreasury, 200));
  });

  test("buildOperation generates contract invocation operation", () => {
    const client = new EscrowGateClient(validConfig);
    const args = client.buildRefundTx(10n);
    const op = client.buildOperation("refund", args);
    assert.strictEqual(op.body.type, "invokeHostFunction");
  });

  test("buildResolveDisputeTx encodes parameters and validates basis points", () => {
    const client = new EscrowGateClient(validConfig);
    const args = client.buildResolveDisputeTx({
      escrowId: 1n,
      caller: validAdmin,
      payerBps: 6000,
      beneficiaryBps: 4000,
    });
    assert.strictEqual(args.length, 4);
    assert.strictEqual(scValToNative(args[0]), 1n);
    assert.strictEqual(scValToNative(args[1]), validAdmin);
    assert.strictEqual(scValToNative(args[2]), 6000);
    assert.strictEqual(scValToNative(args[3]), 4000);

    // Rejects invalid bps sums
    assert.throws(() =>
      client.buildResolveDisputeTx({
        escrowId: 1n,
        caller: validAdmin,
        payerBps: 5000,
        beneficiaryBps: 4000,
      })
    );
  });

  test("buildSetTokenWhitelistTx encodes caller, token, and status", () => {
    const client = new EscrowGateClient(validConfig);
    const args = client.buildSetTokenWhitelistTx({
      caller: validAdmin,
      token: validToken,
      whitelisted: true,
    });
    assert.strictEqual(args.length, 3);
    assert.strictEqual(scValToNative(args[0]), validAdmin);
    assert.strictEqual(scValToNative(args[1]), validToken);
    assert.strictEqual(scValToNative(args[2]), true);
  });

  test("buildGetEscrowTx and buildIsTokenWhitelistedTx encode queries", () => {
    const client = new EscrowGateClient(validConfig);
    const getArgs = client.buildGetEscrowTx(5n);
    assert.strictEqual(getArgs.length, 1);
    assert.strictEqual(scValToNative(getArgs[0]), 5n);

    const isWhiteArgs = client.buildIsTokenWhitelistedTx(validToken);
    assert.strictEqual(isWhiteArgs.length, 1);
    assert.strictEqual(scValToNative(isWhiteArgs[0]), validToken);
  });

  test("contract state enum match", () => {
    assert.strictEqual(EscrowContractState.Funded, "Funded");
    assert.strictEqual(EscrowContractState.Disbursed, "Disbursed");
    assert.strictEqual(EscrowContractState.Refunded, "Refunded");
    assert.strictEqual(EscrowContractState.Disputed, "Disputed");
  });

  test("contract error enum parity match", () => {
    assert.strictEqual(EscrowError.NotInitialized, 1);
    assert.strictEqual(EscrowError.AlreadyInitialized, 2);
    assert.strictEqual(EscrowError.Unauthorized, 3);
    assert.strictEqual(EscrowError.EscrowNotFound, 4);
    assert.strictEqual(EscrowError.InvalidStatus, 5);
    assert.strictEqual(EscrowError.UnlockTimeNotReached, 6);
    assert.strictEqual(EscrowError.UnlockTimePassed, 7);
    assert.strictEqual(EscrowError.ZeroAmount, 8);
    assert.strictEqual(EscrowError.InvalidBps, 9);
    assert.strictEqual(EscrowError.ArithmeticOverflow, 10);
    assert.strictEqual(EscrowError.TokenNotWhitelisted, 11);
    assert.strictEqual(EscrowError.InvalidDisputeSplit, 12);
  });

  test("entry point re-exports units and SEP-38 helpers", () => {
    assert.strictEqual(toStroops("10.50"), 105_000_000n);
    assert.strictEqual(fromStroops(105_000_000n), "10.5");
    assert.strictEqual(typeof getAnchorExchangeQuote, "function");
  });

  test("entry point re-exports dispute split calculator", () => {
    assert.strictEqual(typeof calculateDisputeSplit, "function");
    assert.deepStrictEqual(calculateDisputeSplit(10_000n, 6_000, 4_000), {
      payerAmount: 6_000n,
      beneficiaryAmount: 4_000n,
    });
  });
});
import "./crypto.test";
import "./ttl.test";
import "./units.test";
import "./sep38.test";

/**
 * Indexes a struct `ScVal` by its symbol field names so tests can inspect
 * individual contract fields without relying on encoder ordering.
 */
function structFields(val: xdr.ScVal): Map<string, xdr.ScVal> {
  assert.strictEqual(val.type, "scvMap");
  const fields = new Map<string, xdr.ScVal>();
  for (const entry of val.map ?? []) {
    fields.set(scValToNative(entry.key) as string, entry.val);
  }
  return fields;
}

/**
 * Returns a copy of a struct `ScVal` with one field replaced, so tests can
 * simulate malformed or older contract output.
 */
function withField(
  val: xdr.ScVal,
  field: string,
  replacement: xdr.ScVal
): xdr.ScVal {
  const fields = structFields(val);
  fields.set(field, replacement);
  return xdr.ScVal.scvMap(
    [...fields].map(
      ([key, value]) =>
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: value })
    )
  );
}

describe("Soroban struct encoding (Escrow, FeeConfig, DisputeRecord)", () => {
  const payer = Keypair.random().publicKey();
  const beneficiary = Keypair.random().publicKey();
  const token = Keypair.random().publicKey();
  const treasury = Keypair.random().publicKey();
  const raisedBy = Keypair.random().publicKey();
  const contractAddress =
    "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT";

  const hashA = "e0a9e37d5cb17ded767cf3b2c5a6b12b58403f1a92c909f8555f9c93e18d91e4";
  const hashB = "24c294836d22e6e751d223ceb2e983f9dbf2214a0af1e476d6fe860ea91907c1";

  const I128_MAX = (1n << 127n) - 1n;
  const I128_MIN = -(1n << 127n);
  const U64_MAX = (1n << 64n) - 1n;
  const U128_MAX = (1n << 128n) - 1n;

  const baseEscrow = {
    payer,
    beneficiary,
    token,
    amount: 10_000_000n,
    profileHashHex: hashA,
    status: "Funded" as const,
    unlockTimestamp: 1_760_000_000n,
  };

  test("escrowToScVal emits the contract's EscrowRecord layout", () => {
    const scVal = escrowToScVal(baseEscrow);
    const fields = structFields(scVal);

    assert.deepStrictEqual(
      [...fields.keys()].sort(),
      [
        "amount",
        "beneficiary",
        "payer",
        "profile_hash",
        "status",
        "token",
        "unlock_timestamp",
      ]
    );
    assert.strictEqual(fields.get("payer")!.type, "scvAddress");
    assert.strictEqual(fields.get("beneficiary")!.type, "scvAddress");
    assert.strictEqual(fields.get("token")!.type, "scvAddress");
    assert.strictEqual(fields.get("amount")!.type, "scvI128");
    assert.strictEqual(fields.get("profile_hash")!.type, "scvBytes");
    assert.strictEqual(fields.get("status")!.type, "scvVec");
    assert.strictEqual(fields.get("unlock_timestamp")!.type, "scvU64");

    assert.deepStrictEqual(scValToNative(fields.get("status")!), ["Funded"]);

    assert.deepStrictEqual(scValToEscrow(scVal), baseEscrow);
  });

  test("escrow round-trips i128 and u64 boundary values", () => {
    for (const [amount, unlockTimestamp] of [
      [I128_MAX, U64_MAX],
      [I128_MIN, 0n],
      [0n, 1n],
    ] as const) {
      const escrow = { ...baseEscrow, amount, unlockTimestamp };
      assert.deepStrictEqual(scValToEscrow(escrowToScVal(escrow)), escrow);
    }
  });

  test("escrow round-trips every lifecycle state", () => {
    for (const status of [
      "Funded",
      "Disbursed",
      "Refunded",
      "Disputed",
    ] as const) {
      const escrow = { ...baseEscrow, status };
      assert.deepStrictEqual(scValToEscrow(escrowToScVal(escrow)), escrow);
    }

    // The public enum is assignable to the codec's status union.
    const escrow = { ...baseEscrow, status: EscrowContractState.Refunded };
    assert.strictEqual(scValToEscrow(escrowToScVal(escrow)).status, "Refunded");
  });

  test("escrow encoding is canonical regardless of property order", () => {
    const reordered = {
      unlockTimestamp: baseEscrow.unlockTimestamp,
      status: baseEscrow.status,
      profileHashHex: baseEscrow.profileHashHex,
      amount: baseEscrow.amount,
      token: baseEscrow.token,
      beneficiary: baseEscrow.beneficiary,
      payer: baseEscrow.payer,
    };

    assert.strictEqual(
      escrowToScVal(baseEscrow).toXdr("base64"),
      escrowToScVal(reordered).toXdr("base64")
    );
  });

  test("escrow rejects unformatted addresses", () => {
    for (const field of ["payer", "beneficiary", "token"] as const) {
      for (const invalid of [
        "",
        "INVALID",
        ` ${payer}`,
        `${payer} `,
        `${payer}\n`,
        payer.toLowerCase(),
        payer.slice(0, -1),
        `${payer}0`,
      ]) {
        assert.throws(
          () => escrowToScVal({ ...baseEscrow, [field]: invalid }),
          new RegExp(`${field} must be a formatted Stellar address`),
          `${field} accepted ${JSON.stringify(invalid)}`
        );
      }
    }

    // Contract addresses are valid for the token field.
    const encoded = escrowToScVal({ ...baseEscrow, token: contractAddress });
    assert.strictEqual(scValToEscrow(encoded).token, contractAddress);
  });

  test("escrow rejects invalid 32-byte profile hashes", () => {
    for (const invalid of [
      "",
      hashA.slice(0, 62),
      `${hashA}00`,
      `0x${hashA}`,
      hashA.replace(/^e/, "z"),
      `${hashA.slice(0, 32)}-${hashA.slice(32)}`,
      ` ${hashA}`,
      123 as unknown as string,
    ]) {
      assert.throws(
        () => escrowToScVal({ ...baseEscrow, profileHashHex: invalid }),
        /profileHashHex must be exactly 32 bytes of hexadecimal \(64 hex characters\)/,
        `accepted ${String(invalid)}`
      );
    }

    // Uppercase hex is valid and normalized to lowercase on decode.
    const decoded = scValToEscrow(
      escrowToScVal({ ...baseEscrow, profileHashHex: hashA.toUpperCase() })
    );
    assert.strictEqual(decoded.profileHashHex, hashA);
  });

  test("escrow rejects out-of-range and wrongly typed fields", () => {
    assert.throws(
      () => escrowToScVal({ ...baseEscrow, amount: 1n << 127n }),
      /amount is out of range for i128/
    );
    assert.throws(
      () => escrowToScVal({ ...baseEscrow, amount: I128_MIN - 1n }),
      /amount is out of range for i128/
    );
    assert.throws(
      () => escrowToScVal({ ...baseEscrow, unlockTimestamp: U64_MAX + 1n }),
      /unlockTimestamp is out of range for u64/
    );
    assert.throws(
      () => escrowToScVal({ ...baseEscrow, unlockTimestamp: -1n }),
      /unlockTimestamp is out of range for u64/
    );
    assert.throws(
      () => escrowToScVal({ ...baseEscrow, amount: 1 as unknown as bigint }),
      /amount must be a bigint/
    );
    assert.throws(
      () => escrowToScVal({ ...baseEscrow, status: "Settled" as never }),
      /status must be one of Funded, Disbursed, Refunded, Disputed/
    );
    assert.throws(
      () =>
        escrowToScVal({
          ...baseEscrow,
          profilehashhex: hashA,
        } as unknown as typeof baseEscrow),
      /Escrow contains unsupported field\(s\): profilehashhex/
    );
    assert.throws(
      () => escrowToScVal(null as unknown as typeof baseEscrow),
      /Escrow must be an object/
    );
    assert.throws(
      () => escrowToScVal([] as unknown as typeof baseEscrow),
      /Escrow must be an object/
    );
  });

  test("scValToEscrow rejects malformed structs", () => {
    assert.throws(() => scValToEscrow(nativeToScVal(1)), /must be a Soroban struct/);

    const missing = new Map(structFields(escrowToScVal(baseEscrow)));
    missing.delete("profile_hash");
    const missingScVal = xdr.ScVal.scvMap(
      [...missing].map(
        ([key, val]) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
      )
    );
    assert.throws(
      () => scValToEscrow(missingScVal),
      /Escrow is missing required field "profile_hash"/
    );

    const width = new Map(structFields(escrowToScVal(baseEscrow)));
    width.set("amount", nativeToScVal(1n, { type: "u128" }));
    const widthScVal = xdr.ScVal.scvMap(
      [...width].map(
        ([key, val]) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
      )
    );
    assert.throws(() => scValToEscrow(widthScVal), /amount must be a Soroban scvI128 ScVal/);

    const shortHash = new Map(structFields(escrowToScVal(baseEscrow)));
    shortHash.set("profile_hash", xdr.ScVal.scvBytes(Buffer.alloc(31)));
    const shortHashScVal = xdr.ScVal.scvMap(
      [...shortHash].map(
        ([key, val]) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
      )
    );
    assert.throws(
      () => scValToEscrow(shortHashScVal),
      /profile_hash must be exactly 32 bytes \(got 31\)/
    );

    const badStatus = new Map(structFields(escrowToScVal(baseEscrow)));
    badStatus.set(
      "status",
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Settled")])
    );
    const badStatusScVal = xdr.ScVal.scvMap(
      [...badStatus].map(
        ([key, val]) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
      )
    );
    assert.throws(() => scValToEscrow(badStatusScVal), /status must be one of/);

    const stringAddress = new Map(structFields(escrowToScVal(baseEscrow)));
    stringAddress.set("payer", xdr.ScVal.scvString(payer));
    const stringAddressScVal = xdr.ScVal.scvMap(
      [...stringAddress].map(
        ([key, val]) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
      )
    );
    assert.throws(
      () => scValToEscrow(stringAddressScVal),
      /payer must be a Soroban address ScVal/
    );
  });

  test("feeConfigToScVal round-trips maximum u128 and optional min fee", () => {
    const withMin = {
      feeBps: 250,
      treasury,
      maxFee: U128_MAX,
      minFee: I128_MIN,
    };
    const encoded = feeConfigToScVal(withMin);
    const fields = structFields(encoded);

    assert.deepStrictEqual(
      [...fields.keys()].sort(),
      ["fee_bps", "max_fee", "min_fee", "treasury"]
    );
    assert.strictEqual(fields.get("fee_bps")!.type, "scvU32");
    assert.strictEqual(fields.get("max_fee")!.type, "scvU128");
    assert.strictEqual(fields.get("min_fee")!.type, "scvI128");
    assert.deepStrictEqual(scValToFeeConfig(encoded), withMin);

    const withoutMin = { feeBps: 0, treasury, maxFee: 0n };
    const absent = structFields(feeConfigToScVal(withoutMin));
    assert.strictEqual(absent.get("min_fee")!.type, "scvVoid");
    assert.deepStrictEqual(scValToFeeConfig(feeConfigToScVal(withoutMin)), {
      ...withoutMin,
      minFee: undefined,
    });

    // The encoder accepts the contract's maximum of 1,000 bps.
    assert.strictEqual(
      scValToFeeConfig(feeConfigToScVal({ ...withoutMin, feeBps: 1000 })).feeBps,
      1000
    );
  });

  test("feeConfigToScVal rejects invalid configuration", () => {
    const valid = { feeBps: 100, treasury, maxFee: 1_000n };

    assert.throws(
      () => feeConfigToScVal({ ...valid, feeBps: 1001 }),
      /feeBps must be between 0 and 1000/
    );
    assert.throws(
      () => feeConfigToScVal({ ...valid, feeBps: -1 }),
      /feeBps must be between 0 and 1000/
    );
    assert.throws(
      () => feeConfigToScVal({ ...valid, feeBps: 2.5 }),
      /feeBps must be an integer/
    );
    assert.throws(
      () => feeConfigToScVal({ ...valid, maxFee: U128_MAX + 1n }),
      /maxFee is out of range for u128/
    );
    assert.throws(
      () => feeConfigToScVal({ ...valid, maxFee: -1n }),
      /maxFee is out of range for u128/
    );
    assert.throws(
      () => feeConfigToScVal({ ...valid, minFee: 2_000n }),
      /minFee cannot exceed maxFee/
    );
    assert.throws(
      () => feeConfigToScVal({ ...valid, minFee: I128_MIN - 1n }),
      /minFee is out of range for i128/
    );
    assert.throws(
      () =>
        feeConfigToScVal({
          ...valid,
          minFee: 1 as unknown as bigint,
        }),
      /minFee must be a bigint/
    );
    assert.throws(
      () => feeConfigToScVal({ ...valid, treasury: treasury.toLowerCase() }),
      /treasury must be a formatted Stellar address/
    );
    assert.throws(
      () =>
        feeConfigToScVal({
          ...valid,
          feesBps: 100,
        } as unknown as typeof valid),
      /FeeConfig contains unsupported field\(s\): feesBps/
    );
    assert.throws(
      () => scValToFeeConfig(nativeToScVal("not a struct")),
      /must be a Soroban struct/
    );

    const missing = new Map(
      structFields(feeConfigToScVal(valid))
    );
    missing.delete("max_fee");
    assert.throws(
      () =>
        scValToFeeConfig(
          xdr.ScVal.scvMap(
            [...missing].map(
              ([key, val]) =>
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
            )
          )
        ),
      /FeeConfig is missing required field "max_fee"/
    );

    const outOfRange = new Map(
      structFields(feeConfigToScVal(valid))
    );
    outOfRange.set("fee_bps", nativeToScVal(1001, { type: "u32" }));
    assert.throws(
      () =>
        scValToFeeConfig(
          xdr.ScVal.scvMap(
            [...outOfRange].map(
              ([key, val]) =>
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
            )
          )
        ),
      /fee_bps must be between 0 and 1000 \(got 1001\)/
    );
  });

  test("disputeRecordToScVal round-trips an empty evidence vector and options", () => {
    const record = {
      escrowId: 42n,
      raisedBy,
      reasonHashHex: hashA,
      payerBps: 6_000,
      beneficiaryBps: 4_000,
      resolved: false,
      evidenceHashesHex: [],
    };

    const fields = structFields(disputeRecordToScVal(record));
    assert.deepStrictEqual(
      [...fields.keys()].sort(),
      [
        "beneficiary_bps",
        "escrow_id",
        "evidence_hashes",
        "payer_bps",
        "raised_by",
        "reason_hash",
        "resolution_note",
        "resolved",
        "resolved_at",
      ]
    );
    assert.strictEqual(fields.get("escrow_id")!.type, "scvU64");
    assert.strictEqual(fields.get("resolved")!.type, "scvBool");
    assert.strictEqual(fields.get("evidence_hashes")!.type, "scvVec");
    assert.deepStrictEqual(scValToNative(fields.get("evidence_hashes")!), []);
    assert.strictEqual(fields.get("resolved_at")!.type, "scvVoid");
    assert.strictEqual(fields.get("resolution_note")!.type, "scvVoid");

    assert.deepStrictEqual(scValToDisputeRecord(disputeRecordToScVal(record)), {
      ...record,
      resolvedAt: undefined,
      resolutionNote: undefined,
    });
  });

  test("disputeRecordToScVal round-trips resolved disputes with evidence", () => {
    const record = {
      escrowId: U64_MAX,
      raisedBy,
      reasonHashHex: hashA,
      payerBps: 0,
      beneficiaryBps: 10_000,
      resolved: true,
      evidenceHashesHex: [hashA, hashB.toUpperCase()],
      resolvedAt: U64_MAX,
      resolutionNote: "Evidence reviewed; funds reallocated to payer.",
    };

    const decoded = scValToDisputeRecord(disputeRecordToScVal(record));
    assert.deepStrictEqual(decoded, {
      ...record,
      evidenceHashesHex: [hashA, hashB],
    });
  });

  test("disputeRecordToScVal supports unresolved records without optional fields", () => {
    const record = {
      escrowId: 1n,
      raisedBy,
      reasonHashHex: hashB,
      payerBps: 5_000,
      beneficiaryBps: 5_000,
      resolved: false,
      evidenceHashesHex: [hashA],
    };
    assert.deepStrictEqual(scValToDisputeRecord(disputeRecordToScVal(record)), {
      ...record,
      resolvedAt: undefined,
      resolutionNote: undefined,
    });
  });

  test("disputeRecordToScVal rejects malformed records", () => {
    const valid = {
      escrowId: 1n,
      raisedBy,
      reasonHashHex: hashA,
      payerBps: 5_000,
      beneficiaryBps: 5_000,
      resolved: false,
      evidenceHashesHex: [hashA],
    };

    assert.throws(
      () => disputeRecordToScVal({ ...valid, escrowId: U64_MAX + 1n }),
      /escrowId is out of range for u64/
    );
    assert.throws(
      () => disputeRecordToScVal({ ...valid, escrowId: -1n }),
      /escrowId is out of range for u64/
    );
    assert.throws(
      () => disputeRecordToScVal({ ...valid, raisedBy: ` ${raisedBy}` }),
      /raisedBy must be a formatted Stellar address/
    );
    assert.throws(
      () => disputeRecordToScVal({ ...valid, reasonHashHex: hashA.slice(2) }),
      /reasonHashHex must be exactly 32 bytes of hexadecimal/
    );
    assert.throws(
      () => disputeRecordToScVal({ ...valid, payerBps: 10_001 }),
      /payerBps must be between 0 and 10000/
    );
    assert.throws(
      () => disputeRecordToScVal({ ...valid, beneficiaryBps: 1.5 }),
      /beneficiaryBps must be an integer/
    );
    assert.throws(
      () => disputeRecordToScVal({ ...valid, resolved: 1 as unknown as boolean }),
      /resolved must be a boolean/
    );
    assert.throws(
      () =>
        disputeRecordToScVal({
          ...valid,
          evidenceHashesHex: "not-an-array" as unknown as string[],
        }),
      /evidenceHashesHex must be an array/
    );
    assert.throws(
      () => disputeRecordToScVal({ ...valid, evidenceHashesHex: [hashA, "00"] }),
      /evidenceHashesHex\[1\] must be exactly 32 bytes of hexadecimal/
    );
    assert.throws(
      () => disputeRecordToScVal({ ...valid, resolvedAt: U64_MAX + 1n }),
      /resolvedAt is out of range for u64/
    );
    assert.throws(
      () =>
        disputeRecordToScVal({
          ...valid,
          resolutionNote: 7 as unknown as string,
        }),
      /resolutionNote must be a string/
    );
    assert.throws(
      () =>
        disputeRecordToScVal({
          ...valid,
          evidence_hash: hashA,
        } as unknown as typeof valid),
      /DisputeRecord contains unsupported field\(s\): evidence_hash/
    );
  });

  test("scValToDisputeRecord rejects malformed structs and tolerates unknown fields", () => {
    const record = {
      escrowId: 1n,
      raisedBy,
      reasonHashHex: hashA,
      payerBps: 5_000,
      beneficiaryBps: 5_000,
      resolved: false,
      evidenceHashesHex: [hashA],
    };
    const encoded = disputeRecordToScVal(record);

    // Optional fields may be absent entirely (older contract versions).
    const withoutOptionals = new Map(structFields(encoded));
    withoutOptionals.delete("resolved_at");
    withoutOptionals.delete("resolution_note");
    withoutOptionals.set("future_field", nativeToScVal("ignored"));
    const decoded = scValToDisputeRecord(
      xdr.ScVal.scvMap(
        [...withoutOptionals].map(
          ([key, val]) =>
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
        )
      )
    );
    assert.strictEqual(decoded.resolvedAt, undefined);
    assert.strictEqual(decoded.resolutionNote, undefined);

    const notVector = new Map(structFields(encoded));
    notVector.set("evidence_hashes", nativeToScVal("nope"));
    assert.throws(
      () =>
        scValToDisputeRecord(
          xdr.ScVal.scvMap(
            [...notVector].map(
              ([key, val]) =>
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
            )
          )
        ),
      /evidence_hashes must be a Soroban vector ScVal/
    );

    const shortEvidence = new Map(structFields(encoded));
    shortEvidence.set(
      "evidence_hashes",
      xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.alloc(16))])
    );
    assert.throws(
      () =>
        scValToDisputeRecord(
          xdr.ScVal.scvMap(
            [...shortEvidence].map(
              ([key, val]) =>
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
            )
          )
        ),
      /evidence_hashes\[0\] must be exactly 32 bytes \(got 16\)/
    );

    const badNote = new Map(structFields(encoded));
    badNote.set("resolution_note", nativeToScVal(42));
    assert.throws(
      () =>
        scValToDisputeRecord(
          xdr.ScVal.scvMap(
            [...badNote].map(
              ([key, val]) =>
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
            )
          )
        ),
      /resolution_note must be a Soroban string ScVal/
    );
  });

  test("scValToEscrow accepts flattened enum forms and rejects malformed ones", () => {
    const encoded = escrowToScVal(baseEscrow);

    assert.strictEqual(
      scValToEscrow(
        withField(encoded, "status", xdr.ScVal.scvSymbol("Disbursed"))
      ).status,
      "Disbursed"
    );
    assert.strictEqual(
      scValToEscrow(
        withField(encoded, "status", xdr.ScVal.scvString("Disputed"))
      ).status,
      "Disputed"
    );

    assert.throws(
      () =>
        scValToEscrow(
          withField(
            encoded,
            "status",
            xdr.ScVal.scvVec([
              xdr.ScVal.scvSymbol("Funded"),
              xdr.ScVal.scvSymbol("Refunded"),
            ])
          )
        ),
      /status must be one of/
    );
    assert.throws(
      () =>
        scValToEscrow(
          withField(
            encoded,
            "status",
            xdr.ScVal.scvVec([nativeToScVal(1)])
          )
        ),
      /status must be one of/
    );
  });

  test("decoders reject the wrong ScVal kind for a field", () => {
    const escrow = escrowToScVal(baseEscrow);
    assert.throws(
      () =>
        scValToEscrow(
          withField(escrow, "profile_hash", xdr.ScVal.scvString("nope"))
        ),
      /profile_hash must be a Soroban bytes ScVal/
    );

    const dispute = disputeRecordToScVal({
      escrowId: 1n,
      raisedBy,
      reasonHashHex: hashA,
      payerBps: 5_000,
      beneficiaryBps: 5_000,
      resolved: false,
      evidenceHashesHex: [],
    });
    assert.throws(
      () =>
        scValToDisputeRecord(
          withField(dispute, "reason_hash", xdr.ScVal.scvString(hashA))
        ),
      /reason_hash must be a Soroban bytes ScVal/
    );
    assert.throws(
      () =>
        scValToDisputeRecord(
          withField(dispute, "payer_bps", nativeToScVal(1n))
        ),
      /payer_bps must be a Soroban u32 ScVal/
    );
    assert.throws(
      () =>
        scValToDisputeRecord(
          withField(dispute, "beneficiary_bps", nativeToScVal(1n))
        ),
      /beneficiary_bps must be a Soroban u32 ScVal/
    );
    assert.throws(
      () =>
        scValToDisputeRecord(
          withField(dispute, "resolved", nativeToScVal(1))
        ),
      /resolved must be a Soroban bool ScVal/
    );
    assert.throws(
      () =>
        scValToDisputeRecord(
          withField(dispute, "resolved_at", nativeToScVal(1n, { type: "i128" }))
        ),
      /resolved_at must be a Soroban scvU64 ScVal/
    );

    const feeConfig = feeConfigToScVal({ feeBps: 1, treasury, maxFee: 1n });
    assert.throws(
      () =>
        scValToFeeConfig(
          withField(feeConfig, "treasury", xdr.ScVal.scvString(treasury))
        ),
      /treasury must be a Soroban address ScVal/
    );

    const numericKey = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: nativeToScVal(1, { type: "u32" }),
        val: nativeToScVal(1, { type: "u32" }),
      }),
    ]);
    assert.throws(
      () => scValToEscrow(numericKey),
      /Escrow contains a non-symbol field name/
    );
  });

  test("scValToFeeConfig rejects a decoded min_fee above max_fee", () => {
    const encoded = feeConfigToScVal({
      feeBps: 1,
      treasury,
      maxFee: 1_000n,
      minFee: 100n,
    });
    assert.throws(
      () =>
        scValToFeeConfig(
          withField(encoded, "max_fee", nativeToScVal(50n, { type: "u128" }))
        ),
      /min_fee \(100\) cannot exceed max_fee \(50\)/
    );
  });

  test("scValToDisputeRecord validates decoded shares and notes", () => {
    const encoded = disputeRecordToScVal({
      escrowId: 1n,
      raisedBy,
      reasonHashHex: hashA,
      payerBps: 5_000,
      beneficiaryBps: 5_000,
      resolved: false,
      evidenceHashesHex: [],
    });

    assert.throws(
      () =>
        scValToDisputeRecord(
          withField(encoded, "payer_bps", nativeToScVal(10_001, { type: "u32" }))
        ),
      /payer_bps must be between 0 and 10000 \(got 10001\)/
    );
    assert.throws(
      () =>
        scValToDisputeRecord(
          withField(
            encoded,
            "beneficiary_bps",
            nativeToScVal(10_001, { type: "u32" })
          )
        ),
      /beneficiary_bps must be between 0 and 10000 \(got 10001\)/
    );
    assert.throws(
      () =>
        scValToDisputeRecord(
          withField(
            encoded,
            "resolution_note",
            xdr.ScVal.scvString(new Uint8Array([0xff, 0xfe]))
          )
        ),
      /resolution_note could not be decoded as UTF-8 text/
    );
  });
});
