#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${package_dir}/../.." && pwd)"

if [[ -z "${DB_MAP_URL:-}" ]]; then
  echo "DB_MAP_URL is required"
  exit 1
fi

eval "$(
  bash "${repo_root}/scripts/check-postgres-client-version.sh" \
    DB_MAP_URL \
    "@lib/db-map" \
    --print-env
)"

"${CURSOR_POSTGRES_PG_DUMP}" "$DB_MAP_URL" \
  --schema-only \
  --schema=public \
  --no-owner \
  --no-privileges \
  --exclude-table=public.schema_migrations_cursor \
  | sed \
      -e '/^-- Dumped from database version /d' \
      -e '/^-- Dumped by pg_dump version /d' \
      -e '/^\\restrict /d' \
      -e '/^\\unrestrict /d' \
      -e '/^CREATE SCHEMA public;$/d' \
      -e "/^COMMENT ON SCHEMA public IS 'standard public schema';$/d" \
  > "${package_dir}/schema/current.sql"

echo "Wrote schema/current.sql"
