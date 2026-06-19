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

default_psql_path="$(command -v psql || true)"
default_pg_dump_path="$(command -v pg_dump || true)"

if [[ -z "${default_psql_path}" || -z "${default_pg_dump_path}" ]]; then
  echo "Both psql and pg_dump are required for ${package_name}" >&2
  exit 1
fi

server_version="$("${default_psql_path}" "${connection_string}" -Atqc "SHOW server_version;" 2>/dev/null)"
server_major="${server_version%%.*}"

if [[ -z "${server_major}" ]]; then
  echo "Failed to determine PostgreSQL server version for ${package_name}" >&2
  exit 1
fi

preferred_homebrew_prefix="/opt/homebrew/opt/postgresql@${server_major}/bin"
if [[ -x "${preferred_homebrew_prefix}/psql" && -x "${preferred_homebrew_prefix}/pg_dump" ]]; then
  psql_path="${preferred_homebrew_prefix}/psql"
  pg_dump_path="${preferred_homebrew_prefix}/pg_dump"
else
  psql_path="${default_psql_path}"
  pg_dump_path="${default_pg_dump_path}"
fi

client_version="$("${pg_dump_path}" --version | extract_version)"
client_major="${client_version%%.*}"

if [[ "${client_major}" != "${server_major}" ]]; then
  echo "PostgreSQL client/server major version mismatch for ${package_name}: client ${client_version}, server ${server_version}" >&2
  exit 1
fi

printf 'export CURSOR_POSTGRES_PSQL=%q\n' "${psql_path}"
printf 'export CURSOR_POSTGRES_PG_DUMP=%q\n' "${pg_dump_path}"
