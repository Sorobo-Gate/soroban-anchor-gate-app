/**
 * KYC oracle attestation signing.
 *
 * Verified financial oracles attest to a user's KYC profile by signing the
 * pair `(user_address, profile_hash)` together with the time of attestation.
 * The signed payload is domain-separated and binary-encoded so the same bytes
 * can be passed to Soroban's `env.crypto().ed25519_verify(public_key,
 * signature, message)` without any re-interpretation on-chain.
 *
 * @packageDocumentation
 */

import { Keypair, StrKey } from "@stellar/stellar-sdk";

/**
 * Domain separator prepended to every KYC attestation payload.
 *
 * It prevents a signature over a KYC commitment from being replayed as a
 * signature for any other message signed by the same oracle key.
 */
const KYC_DOMAIN = Buffer.from("SOROBAN_ANCHOR_GATE_KYC_V1\0", "utf8");

/** Maximum value representable by a Soroban `u64` timestamp. */
const U64_MAX = (1n << 64n) - 1n;

/**
 * Signed attestation returned by {@link signKycCommitment}.
 *
 * Every field is already in the exact form consumed by an on-chain
 * `ed25519_verify` call: 32-byte public key, 64-byte signature, and the
 * `Bytes` message that was signed.
 */
export interface KycAttestation {
  /** User account the attestation applies to, as a `G...` StrKey. */
  userAddress: string;
  /** 64-character lowercase hex SHA-256 profile commitment. */
  profileHashHex: string;
  /** Unix timestamp, in seconds, at which the profile was attested. */
  timestamp: bigint;
  /** Oracle public key as a `G...` account address. */
  publicKey: string;
  /** Oracle public key as 32-byte hex, for `BytesN<32>` contract arguments. */
  publicKeyHex: string;
  /** Canonical payload that was signed, as hex, for `Bytes` contract arguments. */
  messageHex: string;
  /** Ed25519 signature as 128-character lowercase hex, for `BytesN<64>`. */
  signatureHex: string;
}

/**
 * Builds the canonical byte payload an oracle signs for a KYC commitment.
 *
 * The encoding is frozen: the domain separator, the raw user address bytes, a
 * single `0x00` separator, the 32-byte profile hash, and the timestamp as an
 * 8-byte big-endian unsigned integer.
 *
 * @param userAddress - User account the attestation applies to.
 * @param profileHashHex - 64-character hex profile commitment.
 * @param timestamp - Unix timestamp in seconds, as a non-negative integer.
 * @returns The payload bytes, suitable for `ed25519_verify`.
 * @throws {Error} If the address, hash, or timestamp is malformed.
 */
export function buildKycCommitmentPayload(
  userAddress: string,
  profileHashHex: string,
  timestamp: bigint
): Uint8Array {
  if (!StrKey.isValidEd25519PublicKey(userAddress)) {
    throw new Error(`Invalid user address: ${userAddress}`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(profileHashHex)) {
    throw new Error("profileHash must be exactly 32 bytes (64 hex characters)");
  }
  if (typeof timestamp !== "bigint") {
    throw new Error("timestamp must be a bigint");
  }
  if (timestamp < 0n || timestamp > U64_MAX) {
    throw new Error("timestamp must be a non-negative u64");
  }

  const timestampBytes = Buffer.alloc(8);
  timestampBytes.writeBigUInt64BE(timestamp);

  return new Uint8Array(
    Buffer.concat([
      KYC_DOMAIN,
      Buffer.from(userAddress, "utf8"),
      Buffer.from([0x00]),
      Buffer.from(profileHashHex, "hex"),
      timestampBytes,
    ])
  );
}

/**
 * Signs a user's KYC commitment with an oracle's Ed25519 key.
 *
 * The private key never leaves the caller's process. The returned signature
 * and payload can be submitted verbatim to the escrow contract, whose
 * `env.crypto().ed25519_verify` implementation accepts the same Ed25519
 * scheme.
 *
 * @param privateKey - Oracle secret key as a `S...` StrKey, or a 32-byte hex seed.
 * @param userAddress - User account the attestation applies to.
 * @param profileHash - 64-character hex SHA-256 commitment to the user's profile.
 * @param timestamp - Unix timestamp in seconds, as a non-negative integer.
 * @returns The signed attestation, including the public key and payload.
 * @throws {Error} If the secret key, address, hash, or timestamp is invalid.
 *
 * @example
 * ```ts
 * const attestation = signKycCommitment(
 *   oracleSecret,
 *   "G...",
 *   profileHashHex,
 *   1_700_000_000n
 * );
 * // attestation.signatureHex is 128 hex characters
 * ```
 */
export function signKycCommitment(
  privateKey: string,
  userAddress: string,
  profileHash: string,
  timestamp: bigint
): KycAttestation {
  const payload = buildKycCommitmentPayload(userAddress, profileHash, timestamp);

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(privateKey);
  } catch {
    throw new Error("Invalid KYC oracle private key");
  }

  const signature = keypair.sign(Buffer.from(payload));

  return {
    userAddress,
    profileHashHex: profileHash.toLowerCase(),
    timestamp,
    publicKey: keypair.publicKey(),
    publicKeyHex: Buffer.from(keypair.rawPublicKey()).toString("hex"),
    messageHex: Buffer.from(payload).toString("hex"),
    signatureHex: Buffer.from(signature).toString("hex"),
  };
}
