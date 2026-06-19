#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Copy all PostgreSQL schema and data from one database to another.

The destination database is wiped first: user schemas, tables, indexes,
and non-default extensions are removed so the restore starts from a clean
state.

Usage:
  SOURCE_DATABASE_URL=<from-url> TARGET_DATABASE_URL=<to-url> ./backup-database.sh

  ./backup-database.sh <SOURCE_ENV_VAR> <TARGET_ENV_VAR>

Examples:
  SOURCE_DATABASE_URL="$DB_MAP_URL" TARGET_DATABASE_URL="$DB_MAP_URL_BACKUP" ./backup-database.sh
  ./backup-database.sh DB_MAP_URL DB_MAP_URL_BACKUP

Environment:
  SOURCE_DATABASE_URL   Connection string for the source database
  TARGET_DATABASE_URL   Connection string for the destination database

Optional:
  PG_DUMP_EXTRA_ARGS    Extra arguments passed to pg_dump (space-separated)
  PSQL_EXTRA_ARGS       Extra arguments passed to psql (space-separated)
EOF
}

log() {
  printf '[backup-database] %s\n' "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

extract_major() {
  local version_output="$1"
  sed -nE 's/.* ([0-9]+)(\.[0-9]+)?([[:space:]].*)?$/\1/p' <<<"$version_output"
}

pick_highest_versioned_bin() {
  local command_name="$1"
  local candidates=()
  local latest=""

  shopt -s nullglob
  candidates=(/usr/lib/postgresql/*/bin/"${command_name}")
  shopt -u nullglob

  if [[ ${#candidates[@]} -eq 0 ]]; then
    return 1
  fi

  latest="$(
    printf '%s\n' "${candidates[@]}" \
      | sort -V \
      | sed -n '$p'
  )"

  [[ -n "$latest" ]] || return 1
  printf '%s\n' "$latest"
}

resolve_database_url() {
  local direct_value="$1"
  local env_name="$2"

  if [[ -n "$direct_value" ]]; then
    printf '%s' "$direct_value"
    return
  fi

  if [[ -z "$env_name" ]]; then
    return 1
  fi

  printf '%s' "${!env_name:-}"
}

resolve_pg_client() {
  local database_url="$1"
  local label="$2"
  local server_major probe_psql psql_bin pg_dump_bin

  if probe_psql="$(pick_highest_versioned_bin psql)"; then
    :
  elif command -v psql >/dev/null 2>&1; then
    probe_psql="$(command -v psql)"
  else
    die "psql is required to connect to ${label}"
  fi

  server_major="$(
    "$probe_psql" "$database_url" -Atqc "SELECT current_setting('server_version_num')::int / 10000"
  )"
  [[ -n "$server_major" ]] || die "unable to determine PostgreSQL server version for ${label}"

  psql_bin="/usr/lib/postgresql/${server_major}/bin/psql"
  pg_dump_bin="/usr/lib/postgresql/${server_major}/bin/pg_dump"

  if [[ ! -x "$psql_bin" ]]; then
    if command -v psql >/dev/null 2>&1; then
      psql_bin="$(command -v psql)"
    else
      psql_bin="$probe_psql"
    fi
  fi

  if [[ ! -x "$pg_dump_bin" ]]; then
    if command -v pg_dump >/dev/null 2>&1; then
      pg_dump_bin="$(command -v pg_dump)"
    else
      die "unable to locate pg_dump for ${label} (server major ${server_major})"
    fi
  fi

  local psql_major pg_dump_major
  psql_major="$(extract_major "$("$psql_bin" --version)")"
  pg_dump_major="$(extract_major "$("$pg_dump_bin" --version)")"

  if [[ -z "$psql_major" || -z "$pg_dump_major" ]]; then
    die "unable to determine PostgreSQL client versions for ${label}"
  fi

  if [[ "$psql_major" != "$server_major" || "$pg_dump_major" != "$server_major" ]]; then
    die "PostgreSQL client/server major version mismatch for ${label} (server=${server_major}, psql=${psql_major}, pg_dump=${pg_dump_major})"
  fi

  log "using PostgreSQL ${server_major} clients for ${label}"
  PSQL_BIN="$psql_bin"
  PG_DUMP_BIN="$pg_dump_bin"
}

wipe_destination() {
  local database_url="$1"

  log "wiping destination database objects"
  "$PSQL_BIN" ${PSQL_EXTRA_ARGS:-} "$database_url" -v ON_ERROR_STOP=1 <<'SQL'
DO $wipe$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT nspname AS name
    FROM pg_namespace
    WHERE nspname NOT LIKE 'pg\_%' ESCAPE '\'
      AND nspname <> 'information_schema'
  LOOP
    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', rec.name);
  END LOOP;

  FOR rec IN
    SELECT extname AS name
    FROM pg_extension
    WHERE extname <> 'plpgsql'
  LOOP
    EXECUTE format('DROP EXTENSION IF EXISTS %I CASCADE', rec.name);
  END LOOP;
END
$wipe$;

CREATE SCHEMA public;
COMMENT ON SCHEMA public IS 'standard public schema';
GRANT ALL ON SCHEMA public TO PUBLIC;
SQL
}

copy_database() {
  local source_url="$1"
  local target_url="$2"
  local -a pg_dump_args=()

  pg_dump_args=(
    --format=plain
    --no-owner
    --no-privileges
    --verbose
  )

  if [[ -n "${PG_DUMP_EXTRA_ARGS:-}" ]]; then
    # shellcheck disable=SC2206
    pg_dump_args+=(${PG_DUMP_EXTRA_ARGS})
  fi

  log "dumping source database"
  log "restoring into destination database"
  "$PG_DUMP_BIN" "${pg_dump_args[@]}" "$source_url" \
    | "$PSQL_BIN" ${PSQL_EXTRA_ARGS:-} "$target_url" -v ON_ERROR_STOP=1
}

main() {
  local source_env_name="${1:-}"
  local target_env_name="${2:-}"
  local source_url target_url

  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  if [[ $# -gt 2 ]]; then
    usage >&2
    exit 1
  fi

  source_url="$(resolve_database_url "${SOURCE_DATABASE_URL:-}" "$source_env_name")" \
    || die "set SOURCE_DATABASE_URL or pass the source env var name as the first argument"
  target_url="$(resolve_database_url "${TARGET_DATABASE_URL:-}" "$target_env_name")" \
    || die "set TARGET_DATABASE_URL or pass the target env var name as the second argument"

  [[ -n "$source_url" ]] || die "source database URL is empty"
  [[ -n "$target_url" ]] || die "target database URL is empty"

  if [[ "$source_url" == "$target_url" ]]; then
    die "source and target database URLs must be different"
  fi

  resolve_pg_client "$source_url" "source"
  local source_psql="$PSQL_BIN" source_pg_dump="$PG_DUMP_BIN"

  resolve_pg_client "$target_url" "target"

  if [[ "$source_pg_dump" != "$PG_DUMP_BIN" || "$source_psql" != "$PSQL_BIN" ]]; then
    log "note: source and target use different PostgreSQL client binaries; using target versions for restore"
  fi

  wipe_destination "$target_url"
  copy_database "$source_url" "$target_url"

  log "backup completed successfully"
}

main "$@"
