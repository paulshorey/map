#!/usr/bin/env bash
set -euo pipefail

# Drop the entire public schema (all tables, indexes, types, sequences), then
# recreate structure from a schema-only SQL file produced by sql-backup-schema.sh.
# Connection URL must be passed via --db-url.
#
# Usage:
#   ./scripts/sql-restore-schema.sh --db-url 'postgresql://...' BACKUP.sql
#   ./scripts/sql-restore-schema.sh --db-url 'postgresql://...' -y BACKUP.sql

usage() {
  cat >&2 <<'EOF'
Drop all public-schema objects, then restore DDL from a schema-only backup. Requires --db-url.

Usage: sql-restore-schema.sh --db-url 'postgresql://...' [-y] BACKUP.sql
  --db-url URL   PostgreSQL connection URL (required)
  -y, --yes      Do not prompt for confirmation
  -h, --help     Show this help
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/sql-db-common.sh
source "${script_dir}/sql-db-common.sh"

DB_URL_ARG=""
DB_ASSUME_YES=0
backup_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    -y | --yes)
      DB_ASSUME_YES=1
      shift
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
      if [[ -n "$backup_file" ]]; then
        echo "$0: too many arguments" >&2
        exit 1
      fi
      backup_file="$1"
      shift
      ;;
  esac
done

if [[ -z "$backup_file" ]]; then
  echo "$0: expected BACKUP.sql argument" >&2
  exit 1
fi
if [[ ! -f "$backup_file" ]]; then
  echo "$0: file not found: $backup_file" >&2
  exit 1
fi

pg_sql_require_url_flag
pg_sql_resolve_clients

if [[ "$DB_ASSUME_YES" -ne 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "$0: stdin is not a terminal; use -y to confirm non-interactively" >&2
    exit 1
  fi
  echo "This will DROP the entire public schema then restore structure from:" >&2
  echo "  $backup_file" >&2
  echo "Database host: $(pg_sql_hostname_from_url "$DB_URL_ARG")" >&2
  read -r -p "Type YES to continue: " confirm
  if [[ "$confirm" != "YES" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

drop_sql="$(mktemp)"
trap 'rm -f "$drop_sql"' EXIT
pg_sql_drop_public_schema_sql >"$drop_sql"

# shellcheck disable=SC2094
{
  cat "$drop_sql"
  cat "$backup_file"
} | "${CURSOR_POSTGRES_PSQL}" "${DB_URL_ARG}" -v ON_ERROR_STOP=1 -f -

echo "Schema restore complete for public schema" >&2
