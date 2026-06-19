#!/usr/bin/env bash
set -euo pipefail

# Dump all row data (no DDL) from the public schema into a local SQL file.
# Connection URL must be passed explicitly via --db-url (not from the environment).
#
# Usage:
#   ./scripts/sql-backup-data.sh --db-url 'postgresql://...' [OUTFILE.sql]
#
# With no OUTFILE, writes to scripts/backups/public-data-YYYYMMDD-HHMMSS.sql

usage() {
  cat >&2 <<'EOF'
Dump all public-schema data (no DDL). Requires --db-url.

Usage: sql-backup-data.sh --db-url 'postgresql://...' [OUTFILE.sql]
  --db-url URL   PostgreSQL connection URL (required)
  -h, --help     Show this help

If OUTFILE is omitted, writes under scripts/backups/public-data-YYYYMMDD-HHMMSS.sql
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/sql-db-common.sh
source "${script_dir}/sql-db-common.sh"

DB_URL_ARG=""
outfile=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --db-url)
      if [[ $# -lt 2 ]]; then
        echo "$0: --db-url requires a value" >&2
        exit 1
      fi
      DB_URL_ARG="$2"
      shift 2
      ;;
    -*)
      echo "$0: unknown option: $1" >&2
      exit 1
      ;;
    *)
      if [[ -n "$outfile" ]]; then
        echo "$0: too many arguments" >&2
        exit 1
      fi
      outfile="$1"
      shift
      ;;
  esac
done

pg_sql_require_url_flag

if [[ -z "$outfile" ]]; then
  backup_dir="$(pg_sql_default_backup_dir)"
  mkdir -p "$backup_dir"
  outfile="${backup_dir}/public-data-$(date +%Y%m%d-%H%M%S).sql"
fi

pg_sql_resolve_clients

tmp_err="$(mktemp)"
tmp_sql="$(mktemp)"
cleanup() {
  rm -f "$tmp_err" "$tmp_sql"
}
trap cleanup EXIT

set +e
"${CURSOR_POSTGRES_PG_DUMP}" "${DB_URL_ARG}" \
  --data-only \
  --schema=public \
  --no-owner \
  --no-privileges \
  2>"$tmp_err" \
  | pg_sql_strip_pg_dump_headers \
  >"$tmp_sql"
dump_status=$?
set -e

if [[ "$dump_status" -ne 0 ]]; then
  cat "$tmp_err" >&2
  exit "$dump_status"
fi

mv -f "$tmp_sql" "$outfile"

echo "Wrote data-only dump for public schema" >&2
echo "$outfile"
