#!/usr/bin/env bash
# Shared helpers for generic PostgreSQL public-schema backup/restore scripts.

pg_sql_helpers_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")" && pwd
}

pg_sql_require_url_flag() {
  if [[ -z "${DB_URL_ARG:-}" ]]; then
    echo "--db-url is required (postgresql://...)" >&2
    exit 1
  fi
  if [[ ! "${DB_URL_ARG}" =~ ^postgres(ql)?:// ]]; then
    echo "--db-url must be a PostgreSQL connection URL (postgresql://...)" >&2
    exit 1
  fi
}

pg_sql_hostname_from_url() {
  local url hostport
  url="$1"
  url="${url#*://}"
  url="${url%%/*}"
  url="${url#*@}"
  hostport="${url%%:*}"
  tr '[:upper:]' '[:lower:]' <<<"$hostport"
}

pg_sql_resolve_clients() {
  local helpers_dir resolve_output
  helpers_dir="$(pg_sql_helpers_dir)"
  if ! resolve_output="$(
    bash "${helpers_dir}/sql-check-postgres-client-version.sh" \
      --url "${DB_URL_ARG}" \
      "postgresql" \
      --print-env
  )"; then
    echo "Failed to resolve PostgreSQL client tools (psql and pg_dump required on PATH)" >&2
    exit 1
  fi
  eval "$resolve_output"
  if [[ -z "${CURSOR_POSTGRES_PSQL:-}" || -z "${CURSOR_POSTGRES_PG_DUMP:-}" ]]; then
    echo "Failed to resolve PostgreSQL client tools (psql and pg_dump required on PATH)" >&2
    exit 1
  fi
}

pg_sql_default_backup_dir() {
  echo "$(pg_sql_helpers_dir)/backups"
}

pg_sql_strip_pg_dump_headers() {
  sed \
    -e '/^-- Dumped from database version /d' \
    -e '/^-- Dumped by pg_dump version /d' \
    -e '/^\\restrict /d' \
    -e '/^\\unrestrict /d'
}

pg_sql_public_table_names() {
  "${CURSOR_POSTGRES_PSQL}" "${DB_URL_ARG}" -Atqc \
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"
}

pg_sql_drop_public_schema_sql() {
  cat <<'EOF'
SET client_min_messages = WARNING;
DROP SCHEMA IF EXISTS public CASCADE;
EOF
}

pg_sql_truncate_public_tables_sql() {
  local tables table_list comma table
  tables="$(pg_sql_public_table_names)"
  printf '%s\n' "SET client_min_messages = WARNING;"
  if [[ -z "$tables" ]]; then
    return 0
  fi
  table_list=""
  comma=0
  while IFS= read -r table; do
    [[ -n "$table" ]] || continue
    if [[ "$comma" -eq 1 ]]; then
      table_list+=', '
    fi
    comma=1
    table_list+="public.${table}"
  done <<<"$tables"
  printf 'TRUNCATE TABLE %s RESTART IDENTITY CASCADE;\n' "$table_list"
}
