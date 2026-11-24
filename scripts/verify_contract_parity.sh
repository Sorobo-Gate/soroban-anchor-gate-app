#!/usr/bin/env bash
#
# verify_contract_parity.sh
# -------------------------
# Verifies that the deployed Soroban contract WASM hash matches the
# locally compiled release WASM bytecode.
#
# Usage:
#   ./scripts/verify_contract_parity.sh \
#     --contract-id CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT \
#     --rpc-url https://soroban-testnet.stellar.org \
#     --network testnet
#
# Environment variables (alternative to flags):
#   CONTRACT_ID, SOROBAN_RPC_URL, STELLAR_NETWORK_PASSPHRASE (or NETWORK)
#
# Exit codes:
#   0  — local and deployed WASM hashes match
#   1  — mismatch, missing prerequisite, or RPC/CLI error
#

set -euo pipefail

###############################################################################
# Helpers
###############################################################################

log()  { echo "[verify_contract_parity] $*"; }
err()  { echo "[verify_contract_parity] ERROR: $*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --contract-id <ID>          Deployed Stellar contract address (required)
  --rpc-url <URL>             Soroban RPC endpoint (required)
  --network <NAME>            Stellar network name for CLI (e.g. testnet)
  --wasm-path <PATH>          Local release WASM path
                              (default: contracts/target/wasm32-unknown-unknown/release/soroban_anchor_escrow.wasm)
  --build                     Run 'cargo build --release --target wasm32-unknown-unknown' before checking
  -h, --help                  Show this help

Environment variables (used when flags are omitted):
  CONTRACT_ID, SOROBAN_RPC_URL, STELLAR_NETWORK_PASSPHRASE, NETWORK, BUILD_CONTRACT

EOF
  exit 0
}

###############################################################################
# Parse arguments
###############################################################################

CONTRACT_ID=""
RPC_URL=""
NETWORK=""
WASM_PATH="contracts/target/wasm32-unknown-unknown/release/soroban_anchor_escrow.wasm"
BUILD_CONTRACT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --contract-id) CONTRACT_ID="$2"; shift 2 ;;
    --rpc-url)     RPC_URL="$2"; shift 2 ;;
    --network)     NETWORK="$2"; shift 2 ;;
    --wasm-path)   WASM_PATH="$2"; shift 2 ;;
    --build)       BUILD_CONTRACT=1; shift ;;
    -h|--help)     usage ;;
    *)             die "Unknown argument: $1" ;;
  esac
done

# Fall back to environment variables
CONTRACT_ID="${CONTRACT_ID:-${CONTRACT_ID_ENV:-}}"
RPC_URL="${RPC_URL:-${SOROBAN_RPC_URL:-}}"
NETWORK="${NETWORK:-${STELLAR_NETWORK_PASSPHRASE:-}}"

if [ -z "$CONTRACT_ID" ]; then
  die "Contract ID is required (--contract-id or CONTRACT_ID env var)"
fi
if [ -z "$RPC_URL" ]; then
  die "RPC URL is required (--rpc-url or SOROBAN_RPC_URL env var)"
fi

###############################################################################
# Prerequisite checks
###############################################################################

log "Checking prerequisites..."

# Hash utility
if command -v sha256sum >/dev/null 2>&1; then
  HASH_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  HASH_CMD="shasum -a 256"
elif command -v openssl >/dev/null 2>&1; then
  HASH_CMD="openssl dgst -sha256"
else
  die "No SHA-256 utility found (sha256sum, shasum, or openssl required)"
fi

# curl + jq for RPC
if ! command -v curl >/dev/null 2>&1; then
  die "curl is required for RPC queries"
fi
if ! command -v jq >/dev/null 2>&1; then
  die "jq is required for parsing RPC responses"
fi

log "Prerequisites OK (hash: $HASH_CMD)"

###############################################################################
# Build local WASM if requested
###############################################################################

if [[ "$BUILD_CONTRACT" -eq 1 ]]; then
  if ! command -v cargo >/dev/null 2>&1; then
    die "cargo is required to build the contract (--build)"
  fi
  log "Building contract WASM (release, wasm32-unknown-unknown)..."
  (cd contracts && cargo build --target wasm32-unknown-unknown --release) \
    || die "Contract build failed"
fi

###############################################################################
# Verify local WASM exists
###############################################################################

if [ ! -f "$WASM_PATH" ]; then
  die "Local release WASM not found at '$WASM_PATH'. Run 'make build-contracts' or pass --build."
fi

###############################################################################
# Compute local WASM hash
###############################################################################

log "Computing local WASM hash: $WASM_PATH"
LOCAL_HASH=$("$HASH_CMD" "$WASM_PATH" | awk '{print $1}')
log "Local WASM hash: $LOCAL_HASH"

###############################################################################
# Fetch deployed contract WASM hash
###############################################################################

FETCHED=0
DEPLOYED_HASH=""

# ── Method 1: Stellar / Soroban CLI ──────────────────────────────────────────
CLI=""
if command -v stellar >/dev/null 2>&1; then
  CLI="stellar"
elif command -v soroban >/dev/null 2>&1; then
  CLI="soroban"
fi

if [[ -n "$CLI" ]]; then
  log "Fetching deployed WASM hash via $CLI CLI..."
  CLI_ARGS=(--id "$CONTRACT_ID")
  if [[ -n "$NETWORK" ]]; then
    CLI_ARGS+=(--network "$NETWORK")
  fi
  if DEPLOYED_HASH=$($CLI contract hash "${CLI_ARGS[@]}" 2>/dev/null); then
    FETCHED=1
    # Trim whitespace
    DEPLOYED_HASH=$(echo "$DEPLOYED_HASH" | tr -d '[:space:]')
    log "Deployed WASM hash (via $CLI): $DEPLOYED_HASH"
  else
    log "CLI hash lookup failed, trying RPC..."
  fi
fi

# ── Method 2: Soroban RPC (getContractData) ──────────────────────────────────
if [[ "$FETCHED" -eq 0 ]]; then
  log "Fetching deployed WASM hash via Soroban RPC ($RPC_URL)..."

  # Contract data key for the WASM hash: 8 zero bytes (base64: AAAAAAA=)
  # Soroban stores the original contract WASM hash under contract data key 0x0000000000000000.
  WASM_HASH_KEY_B64="AAAAAAA="

  RESPONSE=$(curl -s -X POST "$RPC_URL/soroban/rpc" \
    -H 'Content-Type: application/json' \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"id\": 1,
      \"method\": \"getContractData\",
      \"params\": {
        \"contract_id\": \"$CONTRACT_ID\",
        \"key\": {
          \"type\": \"contract_data\",
          \"contract_id\": \"$CONTRACT_ID\",
          \"key\": {\"type\": \"bytes\", \"value\": \"$WASM_HASH_KEY_B64\"}
        }
      }
    }" 2>/dev/null) || die "RPC request failed"

  RPC_ERROR=$(echo "$RESPONSE" | jq -r '.error // empty' 2>/dev/null || true)
  if [[ -n "$RPC_ERROR" && "$RPC_ERROR" != "null" ]]; then
    die "RPC error: $RPC_ERROR"
  fi

  XDR_RESULT=$(echo "$RESPONSE" | jq -r '.result.xdr // empty' 2>/dev/null || true)
  if [[ -z "$XDR_RESULT" || "$XDR_RESULT" == "null" ]]; then
    die "Could not extract deployed WASM hash from RPC response (no .result.xdr field)"
  fi

  # The RPC returns XDR-encoded data as base64. Decode to raw bytes, then hex-encode.
  if command -v base64 >/dev/null 2>&1 && command -v xxd >/dev/null 2>&1; then
    DEPLOYED_HASH=$(echo "$XDR_RESULT" | base64 -d 2>/dev/null | xxd -p -c 64 2>/dev/null | tr -d '\n' || true)
  elif command -v base64 >/dev/null 2>&1 && command -v od >/dev/null 2>&1; then
    DEPLOYED_HASH=$(echo "$XDR_RESULT" | base64 -d 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)
  else
    die "Neither xxd nor od available to decode RPC response"
  fi

  if [[ -z "$DEPLOYED_HASH" ]]; then
    die "Unable to decode deployed WASM hash from RPC response"
  fi

  FETCHED=1
  log "Deployed WASM hash (via RPC): $DEPLOYED_HASH"
fi

if [[ "$FETCHED" -eq 0 ]]; then
  die "Unable to fetch deployed WASM hash: neither stellar/soroban CLI nor RPC succeeded"
fi

###############################################################################
# Compare hashes
###############################################################################

log "Comparing hashes..."
log "  Local  : $LOCAL_HASH"
log "  Deployed: $DEPLOYED_HASH"

if [[ "$LOCAL_HASH" == "$DEPLOYED_HASH" ]]; then
  log "✅ Contract parity verified: local and deployed WASM hashes match."
  exit 0
else
  err "❌ Contract parity MISMATCH:"
  err "  Local  : $LOCAL_HASH"
  err "  Deployed: $DEPLOYED_HASH"
  exit 1
fi
