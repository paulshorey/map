#!/usr/bin/env bash
# No network, services, migrations, host config writes or real credentials.
set -euo pipefail
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/map-agent-env-test.XXXXXX")"
trap 'rm -rf "${fixture_dir}"' EXIT
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-env.sh"
CONFIG_DIR="${fixture_dir}/config"
STATE_DIR="${fixture_dir}/state"
ENV_FILE="${CONFIG_DIR}/agent.env"
persist_shell_hook() { :; }
ensure_dirs
cat > "${ENV_FILE}" <<'EOF'
export DB_MAP_URL='postgresql://fixture'
export FIREWORKS_API_KEY='fake-fixture-value'
export LLM_MODEL='accounts/fireworks/models/deepseek-v4p1-flash'
export LLM_THINKING_BUDGET_TOKENS=2048
EOF
parse_args setup
load_runtime_env
[[ "${LLM_MODEL}" == accounts/fireworks/models/deepseek-v4p1-flash ]]
[[ "${LLM_THINKING_BUDGET_TOKENS}" == 2048 ]]
parse_args setup --reset-llm-defaults
load_runtime_env
[[ -z "${LLM_MODEL+x}" && -z "${LLM_THINKING_BUDGET_TOKENS+x}" ]]
persist_runtime_env
source "${ENV_FILE}"
[[ "${LLM_MODEL}" == accounts/fireworks/models/glm-5p3-flash ]]
[[ -z "${LLM_THINKING_BUDGET_TOKENS+x}" ]]
[[ "${DB_MAP_URL}" == postgresql://fixture && "${FIREWORKS_API_KEY}" == fake-fixture-value ]]
if (parse_args start --reset-llm-defaults >/dev/null 2>&1); then
  echo 'FAIL: reset must require setup' >&2
  exit 1
fi
echo 'PASS: explicit overrides preserved; opt-in LLM migration retains credentials in isolated fixtures.'
