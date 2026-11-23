import assert from "node:assert";
import { test, describe } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { signKycCommitment, buildKycCommitmentPayload } from "./kyc";

const oracle = Keypair.random();
const user = Keypair.random().publicKey();
const profileHash = "e0a9e37d5cb17ded767cf3b2c5a6b12b58403f1a92c909f8555f9c93e18d91e4";
const timestamp = 1_700_000_000n;

describe("signKycCommitment", () => {
  test("produces a verifiable Ed25519 attestation", () => {
    const attestation = signKycCommitment(
      oracle.secret(),
      user,
      profileHash,
      timestamp
    );

    assert.strictEqual(attestation.userAddress, user);
    assert.strictEqual(attestation.publicKey, oracle.publicKey());
    assert.strictEqual(
      attestation.publicKeyHex,
      Buffer.from(oracle.rawPublicKey()).toString("hex")
    );
    assert.strictEqual(attestation.signatureHex.length, 128);
    assert.strictEqual(attestation.messageHex.length > 0, true);

    const verified = Keypair.fromPublicKey(attestation.publicKey).verify(
      Buffer.from(attestation.messageHex, "hex"),
      Buffer.from(attestation.signatureHex, "hex")
    );
    assert.strictEqual(verified, true);
  });

  test("is deterministic for identical inputs", () => {
    const first = signKycCommitment(oracle.secret(), user, profileHash, timestamp);
    const second = signKycCommitment(oracle.secret(), user, profileHash, timestamp);
    assert.strictEqual(first.signatureHex, second.signatureHex);
    assert.strictEqual(first.messageHex, second.messageHex);
  });

  test("binds the signature to address, hash and timestamp", () => {
    const attestation = signKycCommitment(oracle.secret(), user, profileHash, timestamp);
    const signature = Buffer.from(attestation.signatureHex, "hex");
    const verifier = Keypair.fromPublicKey(oracle.publicKey());

    const tampered = buildKycCommitmentPayload(
      user,
      profileHash,
      timestamp + 1n
    );
    assert.strictEqual(verifier.verify(Buffer.from(tampered), signature), false);
  });

  test("normalizes uppercase profile hashes", () => {
    const attestation = signKycCommitment(
      oracle.secret(),
      user,
      profileHash.toUpperCase(),
      timestamp
    );
    assert.strictEqual(attestation.profileHashHex, profileHash);
  });

  test("rejects malformed inputs", () => {
    assert.throws(
      () => signKycCommitment("not-a-secret", user, profileHash, timestamp),
      /private key/
    );
    assert.throws(
      () => signKycCommitment(oracle.secret(), "GINVALID", profileHash, timestamp),
      /Invalid user address/
    );
    assert.throws(
      () => signKycCommitment(oracle.secret(), user, "abcd", timestamp),
      /64 hex characters/
    );
    assert.throws(
      () => signKycCommitment(oracle.secret(), user, profileHash, -1n),
      /non-negative u64/
    );
    assert.throws(
      () => buildKycCommitmentPayload(user, profileHash, 1n << 64n),
      /non-negative u64/
    );
  });
});
