#!/usr/bin/env bash
set -euo pipefail

# Drop all user schemas and non-default extensions, then recreate an empty
# public schema with default grants so migrations or restores can run
# immediately. Connection URL must be passed via --db-url.
#
# Usage:
#   ./scripts/sql-wipe.sh --db-url 'postgresql://...'
#   ./scripts/sql-wipe.sh --db-url 'postgresql://...' -y

usage() {
  cat >&2 <<'EOF'
Wipe a PostgreSQL database back to a freshly created state. Requires --db-url.

Removes all user schemas (including public), drops all extensions except plpgsql,
then recreates public with default grants and ensures plpgsql is present.

Usage: sql-wipe.sh --db-url 'postgresql://...' [-y]
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
      echo "$0: unexpected argument: $1" >&2
      exit 1
      ;;
  esac
done

pg_sql_require_url_flag
pg_sql_resolve_clients

if [[ "$DB_ASSUME_YES" -ne 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "$0: stdin is not a terminal; use -y to confirm non-interactively" >&2
    exit 1
  fi
  echo "This will WIPE the entire database (all user schemas and extensions):" >&2
  echo "  Database host: $(pg_sql_hostname_from_url "$DB_URL_ARG")" >&2
  read -r -p "Type YES to continue: " confirm
  if [[ "$confirm" != "YES" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

{
  printf '%s\n' 'SET client_min_messages = WARNING;'
  pg_sql_drop_user_schemas_and_extensions_sql
  pg_sql_recreate_public_schema_sql
} | "${CURSOR_POSTGRES_PSQL}" "${DB_URL_ARG}" -v ON_ERROR_STOP=1 -f -

echo "Database wipe complete (empty public schema ready for migrations or restore)" >&2
