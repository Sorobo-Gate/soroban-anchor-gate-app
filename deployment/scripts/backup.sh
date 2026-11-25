#!/usr/bin/env bash
# Automated PostgreSQL backup script for Soroban Anchor Gate relay database.
# Dumps the database with pg_dump (custom format + gzip), generates a SHA-256
# checksum, encrypts the archive with GPG, and optionally uploads to S3.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: backup.sh [OPTIONS]

Automated PostgreSQL backup with GPG encryption and optional S3 upload.

Environment variables:
  DATABASE_URL           PostgreSQL connection URI (or PGHOST/PGPORT/PGUSER/PGDATABASE)
  BACKUP_DIR             Local directory for temporary/staged backups (default: /var/backups/soroban-relay)
  BACKUP_GPG_PASSPHRASE  Passphrase for symmetric AES-256 GPG encryption
  GPG_RECIPIENT          GPG key ID/email for asymmetric encryption (alternative to passphrase)
  S3_BUCKET              Optional S3 bucket URI (e.g. s3://my-bucket/relay-backups)
  S3_ENDPOINT_URL        Optional custom S3-compatible endpoint URL
  RETENTION_DAYS         Local backup retention in days (default: 7)

Options:
  --output-dir DIR       Override BACKUP_DIR
  --keep-plain           Keep unencrypted dump alongside encrypted archive (not recommended in prod)
  --skip-upload          Skip S3 upload even if S3_BUCKET is set
  --dry-run              Validate configuration and tools without running pg_dump or upload
  -h, --help             Show this help message
EOF
}

log() {
  printf '[%s] [backup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

err() {
  printf '[%s] [backup] ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Required command '$1' not found in PATH"
    exit 1
  fi
}

BACKUP_DIR="${BACKUP_DIR:-/var/backups/soroban-relay}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
KEEP_PLAIN=false
SKIP_UPLOAD=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      BACKUP_DIR="$2"
      shift 2
      ;;
    --keep-plain)
      KEEP_PLAIN=true
      shift
      ;;
    --skip-upload)
      SKIP_UPLOAD=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
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

require_cmd pg_dump
require_cmd gpg
require_cmd sha256sum

if [[ -z "${DATABASE_URL:-}" && -z "${PGDATABASE:-}" ]]; then
  err "Either DATABASE_URL or PGDATABASE must be set"
  exit 1
fi

if [[ -z "${GPG_RECIPIENT:-}" && -z "${BACKUP_GPG_PASSPHRASE:-}" ]]; then
  err "Either GPG_RECIPIENT or BACKUP_GPG_PASSPHRASE must be set for encryption"
  exit 1
fi

if [[ "${SKIP_UPLOAD}" == "false" && -n "${S3_BUCKET:-}" ]]; then
  require_cmd aws
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_NAME="relay-db-${TIMESTAMP}"
DUMP_FILE="${BACKUP_DIR}/${BACKUP_NAME}.dump"
ENCRYPTED_FILE="${DUMP_FILE}.gpg"
CHECKSUM_FILE="${ENCRYPTED_FILE}.sha256"
META_FILE="${BACKUP_DIR}/${BACKUP_NAME}.meta.json"

if [[ "${DRY_RUN}" == "true" ]]; then
  log "Dry run succeeded: tools and configuration validated"
  log "Target dump: ${ENCRYPTED_FILE}"
  exit 0
fi

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

cleanup_plain() {
  if [[ "${KEEP_PLAIN}" == "false" && -f "${DUMP_FILE}" ]]; then
    rm -f "${DUMP_FILE}"
  fi
}
trap cleanup_plain EXIT

log "Starting pg_dump to ${DUMP_FILE}"
if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump --format=custom --compress=9 --no-owner --no-acl --dbname="${DATABASE_URL}" --file="${DUMP_FILE}"
else
  pg_dump --format=custom --compress=9 --no-owner --no-acl --file="${DUMP_FILE}"
fi

if [[ ! -s "${DUMP_FILE}" ]]; then
  err "pg_dump produced an empty file: ${DUMP_FILE}"
  exit 1
fi

log "Encrypting backup archive with GPG -> ${ENCRYPTED_FILE}"
if [[ -n "${GPG_RECIPIENT:-}" ]]; then
  gpg --batch --yes --trust-model always --encrypt --recipient "${GPG_RECIPIENT}" --output "${ENCRYPTED_FILE}" "${DUMP_FILE}"
else
  printf '%s' "${BACKUP_GPG_PASSPHRASE}" | gpg --batch --yes --passphrase-fd 0 --symmetric --cipher-algo AES256 --output "${ENCRYPTED_FILE}" "${DUMP_FILE}"
fi

if [[ ! -s "${ENCRYPTED_FILE}" ]]; then
  err "GPG encryption failed or produced empty file: ${ENCRYPTED_FILE}"
  exit 1
fi

sha256sum "${ENCRYPTED_FILE}" > "${CHECKSUM_FILE}"

cat > "${META_FILE}" <<EOF
{
  "timestamp_utc": "${TIMESTAMP}",
  "backup_file": "$(basename "${ENCRYPTED_FILE}")",
  "checksum_file": "$(basename "${CHECKSUM_FILE}")",
  "format": "pg_dump_custom_gpg",
  "size_bytes": $(wc -c < "${ENCRYPTED_FILE}" | tr -d ' ')
}
EOF

if [[ "${SKIP_UPLOAD}" == "false" && -n "${S3_BUCKET:-}" ]]; then
  S3_PREFIX="${S3_BUCKET%/}/${TIMESTAMP}"
  AWS_ARGS=()
  if [[ -n "${S3_ENDPOINT_URL:-}" ]]; then
    AWS_ARGS+=(--endpoint-url "${S3_ENDPOINT_URL}")
  fi
  log "Uploading encrypted backup, checksum, and metadata to ${S3_PREFIX}/"
  aws "${AWS_ARGS[@]}" s3 cp "${ENCRYPTED_FILE}" "${S3_PREFIX}/$(basename "${ENCRYPTED_FILE}")" --sse AES256
  aws "${AWS_ARGS[@]}" s3 cp "${CHECKSUM_FILE}" "${S3_PREFIX}/$(basename "${CHECKSUM_FILE}")" --sse AES256
  aws "${AWS_ARGS[@]}" s3 cp "${META_FILE}" "${S3_PREFIX}/$(basename "${META_FILE}")" --sse AES256
else
  log "Skipping S3 upload (S3_BUCKET not set or --skip-upload passed)"
fi

if [[ "${RETENTION_DAYS}" =~ ^[0-9]+$ && "${RETENTION_DAYS}" -gt 0 ]]; then
  find "${BACKUP_DIR}" -maxdepth 1 -type f -name "relay-db-*.gpg*" -mtime "+${RETENTION_DAYS}" -delete || true
  find "${BACKUP_DIR}" -maxdepth 1 -type f -name "relay-db-*.meta.json" -mtime "+${RETENTION_DAYS}" -delete || true
fi

log "Backup completed successfully: ${ENCRYPTED_FILE}"
