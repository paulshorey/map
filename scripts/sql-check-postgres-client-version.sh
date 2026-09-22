#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  sql-check-postgres-client-version.sh <env_var_name> <package_name> --print-env
  sql-check-postgres-client-version.sh --url <connection_string> <package_name> --print-env
EOF
}

connection_string=""
env_var_name=""
package_name=""
mode=""
use_url=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      if [[ $# -lt 2 ]]; then
        usage
        exit 1
      fi
      use_url=1
      connection_string="$2"
      shift 2
      ;;
    --print-env)
      mode="--print-env"
      shift
      ;;
    -*)
      echo "Unsupported option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ "$use_url" -eq 1 ]]; then
        if [[ -z "$package_name" ]]; then
          package_name="$1"
        else
          echo "Too many positional arguments" >&2
          usage
          exit 1
        fi
      elif [[ -z "$env_var_name" ]]; then
        env_var_name="$1"
      elif [[ -z "$package_name" ]]; then
        package_name="$1"
      else
        echo "Too many positional arguments" >&2
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$package_name" || "$mode" != "--print-env" ]]; then
  usage
  exit 1
fi

if [[ -z "$connection_string" ]]; then
  if [[ -z "$env_var_name" ]]; then
    usage
    exit 1
  fi
  connection_string="${!env_var_name:-}"
  if [[ -z "${connection_string}" ]]; then
    echo "${env_var_name} is required for ${package_name}" >&2
    exit 1
  fi
fi

extract_version() {
  sed -E 's/.* ([0-9]+(\.[0-9]+)*).*/\1/'
}

candidate_bins() {
  local major="$1"
  local kind="$2"
  local paths=(
    "/usr/lib/postgresql/${major}/bin/${kind}"
    "/opt/homebrew/opt/postgresql@${major}/bin/${kind}"
    "/usr/local/opt/postgresql@${major}/bin/${kind}"
  )
  local path
  for path in "${paths[@]}"; do
    if [[ -x "${path}" ]]; then
      printf '%s\n' "${path}"
      return 0
    fi
  done
  return 1
}

default_psql_path="$(command -v psql || true)"
default_pg_dump_path="$(command -v pg_dump || true)"

if [[ -z "${default_psql_path}" || -z "${default_pg_dump_path}" ]]; then
  echo "Both psql and pg_dump are required for ${package_name}" >&2
  exit 1
fi

server_version="$("${default_psql_path}" "${connection_string}" -Atqc "SHOW server_version;")"
server_major="${server_version%%.*}"

if [[ -z "${server_major}" ]]; then
  echo "Failed to determine PostgreSQL server version for ${package_name}" >&2
  exit 1
fi

psql_path="${default_psql_path}"
pg_dump_path="${default_pg_dump_path}"
if matched_psql="$(candidate_bins "${server_major}" psql)" && \
   matched_dump="$(candidate_bins "${server_major}" pg_dump)"; then
  psql_path="${matched_psql}"
  pg_dump_path="${matched_dump}"
fi

client_version="$("${pg_dump_path}" --version | extract_version)"
client_major="${client_version%%.*}"

if [[ "${client_major}" != "${server_major}" ]]; then
  echo "PostgreSQL client/server major version mismatch for ${package_name}: client ${client_version}, server ${server_version}" >&2
  echo "Install postgresql-client-${server_major} (Linux) or postgresql@${server_major} (Homebrew), then retry." >&2
  exit 1
fi

printf 'export CURSOR_POSTGRES_PSQL=%q\n' "${psql_path}"
printf 'export CURSOR_POSTGRES_PG_DUMP=%q\n' "${pg_dump_path}"
