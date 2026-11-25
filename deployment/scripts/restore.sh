#!/usr/bin/env bash
# Automated PostgreSQL restore and point-in-time recovery (PITR) validation script
# for the Soroban Anchor Gate relay database.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: restore.sh [OPTIONS]

Decrypts a GPG-encrypted PostgreSQL backup, verifies its SHA-256 checksum,
restores it to the target PostgreSQL database, and validates point-in-time
recovery (PITR) readiness / target timestamp constraints.

Environment variables:
  DATABASE_URL           Target PostgreSQL connection URI (or PGHOST/PGPORT/PGUSER/PGDATABASE)
  BACKUP_GPG_PASSPHRASE  Passphrase for symmetric GPG decryption (if not using key agent)
  S3_ENDPOINT_URL        Optional custom S3-compatible endpoint URL

Options:
  --backup-file PATH     Path or s3:// URI to the .dump.gpg backup archive (required)
  --checksum-file PATH   Optional path to .sha256 file (defaults to <backup-file>.sha256 if present)
  --target-time ISO8601  Optional PITR target timestamp (e.g. 2026-11-25T12:00:00Z)
  --wal-archive-dir DIR  Optional WAL archive directory to configure/validate PITR
  --pg-data-dir DIR      Optional PostgreSQL data directory for writing recovery.signal
  --clean                Drop and recreate database objects before restoring (--clean --if-exists)
  --verify-only          Decrypt and verify archive integrity without modifying target database
  -h, --help             Show this help message
EOF
}

log() {
  printf '[%s] [restore] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

err() {
  printf '[%s] [restore] ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Required command '$1' not found in PATH"
    exit 1
  fi
}

validate_iso8601() {
  local ts="$1"
  if ! date -u -d "${ts}" +%s >/dev/null 2>&1; then
    err "Invalid PITR --target-time '${ts}'. Expected ISO-8601 timestamp (e.g. 2026-11-25T12:00:00Z)"
    exit 1
  fi
}

BACKUP_FILE=""
CHECKSUM_FILE=""
TARGET_TIME=""
WAL_ARCHIVE_DIR=""
PG_DATA_DIR=""
CLEAN_RESTORE=false
VERIFY_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-file)
      BACKUP_FILE="$2"
      shift 2
      ;;
    --checksum-file)
      CHECKSUM_FILE="$2"
      shift 2
      ;;
    --target-time)
      TARGET_TIME="$2"
      shift 2
      ;;
    --wal-archive-dir)
      WAL_ARCHIVE_DIR="$2"
      shift 2
      ;;
    --pg-data-dir)
      PG_DATA_DIR="$2"
      shift 2
      ;;
    --clean)
      CLEAN_RESTORE=true
      shift
      ;;
    --verify-only)
      VERIFY_ONLY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${BACKUP_FILE}" ]]; then
  err "--backup-file is required"
  usage
  exit 1
fi

require_cmd gpg
require_cmd sha256sum
require_cmd pg_restore
require_cmd psql

if [[ -n "${TARGET_TIME}" ]]; then
  validate_iso8601 "${TARGET_TIME}"
fi

WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

LOCAL_ENCRYPTED="${WORK_DIR}/backup.dump.gpg"
LOCAL_CHECKSUM="${WORK_DIR}/backup.dump.gpg.sha256"
DECRYPTED_DUMP="${WORK_DIR}/backup.dump"

if [[ "${BACKUP_FILE}" == s3://* ]]; then
  require_cmd aws
  AWS_ARGS=()
  if [[ -n "${S3_ENDPOINT_URL:-}" ]]; then
    AWS_ARGS+=(--endpoint-url "${S3_ENDPOINT_URL}")
  fi
  log "Downloading encrypted backup from ${BACKUP_FILE}"
  aws "${AWS_ARGS[@]}" s3 cp "${BACKUP_FILE}" "${LOCAL_ENCRYPTED}"
  if [[ -n "${CHECKSUM_FILE}" ]]; then
    aws "${AWS_ARGS[@]}" s3 cp "${CHECKSUM_FILE}" "${LOCAL_CHECKSUM}"
  else
    aws "${AWS_ARGS[@]}" s3 cp "${BACKUP_FILE}.sha256" "${LOCAL_CHECKSUM}" 2>/dev/null || true
  fi
else
  if [[ ! -f "${BACKUP_FILE}" ]]; then
    err "Backup file not found: ${BACKUP_FILE}"
    exit 1
  fi
  cp "${BACKUP_FILE}" "${LOCAL_ENCRYPTED}"
  if [[ -n "${CHECKSUM_FILE}" ]]; then
    cp "${CHECKSUM_FILE}" "${LOCAL_CHECKSUM}"
  elif [[ -f "${BACKUP_FILE}.sha256" ]]; then
    cp "${BACKUP_FILE}.sha256" "${LOCAL_CHECKSUM}"
  fi
fi

if [[ -f "${LOCAL_CHECKSUM}" ]]; then
  log "Verifying SHA-256 checksum"
  EXPECTED_HASH="$(awk '{print $1}' "${LOCAL_CHECKSUM}")"
  ACTUAL_HASH="$(sha256sum "${LOCAL_ENCRYPTED}" | awk '{print $1}')"
  if [[ "${EXPECTED_HASH}" != "${ACTUAL_HASH}" ]]; then
    err "Checksum mismatch! Expected ${EXPECTED_HASH}, got ${ACTUAL_HASH}"
    exit 1
  fi
  log "Checksum verified: ${ACTUAL_HASH}"
fi

log "Decrypting backup archive"
if [[ -n "${BACKUP_GPG_PASSPHRASE:-}" ]]; then
  printf '%s' "${BACKUP_GPG_PASSPHRASE}" | gpg --batch --yes --passphrase-fd 0 --decrypt --output "${DECRYPTED_DUMP}" "${LOCAL_ENCRYPTED}"
else
  gpg --batch --yes --decrypt --output "${DECRYPTED_DUMP}" "${LOCAL_ENCRYPTED}"
fi

if [[ ! -s "${DECRYPTED_DUMP}" ]]; then
  err "Decrypted dump is empty"
  exit 1
fi

log "Validating pg_dump archive table-of-contents"
pg_restore --list "${DECRYPTED_DUMP}" >/dev/null

if [[ -n "${TARGET_TIME}" && -n "${WAL_ARCHIVE_DIR}" ]]; then
  if [[ ! -d "${WAL_ARCHIVE_DIR}" ]]; then
    err "WAL archive directory does not exist: ${WAL_ARCHIVE_DIR}"
    exit 1
  fi
  log "PITR configuration validated for target_time=${TARGET_TIME} using WAL dir ${WAL_ARCHIVE_DIR}"
  if [[ -n "${PG_DATA_DIR}" ]]; then
    if [[ ! -d "${PG_DATA_DIR}" ]]; then
      err "PostgreSQL data directory does not exist: ${PG_DATA_DIR}"
      exit 1
    fi
    touch "${PG_DATA_DIR}/recovery.signal"
    cat >> "${PG_DATA_DIR}/postgresql.auto.conf" <<EOF
restore_command = 'cp ${WAL_ARCHIVE_DIR}/%f %p'
recovery_target_time = '${TARGET_TIME}'
recovery_target_action = 'promote'
EOF
    log "Wrote PITR recovery.signal and postgresql.auto.conf in ${PG_DATA_DIR}"
  fi
fi

if [[ "${VERIFY_ONLY}" == "true" ]]; then
  log "Verification-only mode complete; archive is valid and decryptable"
  exit 0
fi

if [[ -z "${DATABASE_URL:-}" && -z "${PGDATABASE:-}" ]]; then
  err "Either DATABASE_URL or PGDATABASE must be set to perform restore"
  exit 1
fi

RESTORE_ARGS=(--no-owner --no-acl --single-transaction --exit-on-error)
if [[ "${CLEAN_RESTORE}" == "true" ]]; then
  RESTORE_ARGS+=(--clean --if-exists)
fi

log "Restoring database from decrypted archive"
if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_restore "${RESTORE_ARGS[@]}" --dbname="${DATABASE_URL}" "${DECRYPTED_DUMP}"
else
  pg_restore "${RESTORE_ARGS[@]}" --dbname="${PGDATABASE}" "${DECRYPTED_DUMP}"
fi

log "Validating restored database connectivity and schema"
if [[ -n "${DATABASE_URL:-}" ]]; then
  TABLE_COUNT="$(psql "${DATABASE_URL}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")"
else
  TABLE_COUNT="$(psql -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")"
fi

log "Restore completed successfully (${TABLE_COUNT} public tables present)"
