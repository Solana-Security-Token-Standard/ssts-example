#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_cmd node

for arg in "$@"; do
  if [ "${arg}" = "--help" ] || [ "${arg}" = "-h" ]; then
    TOKEN_ROOT="${TOKEN_ROOT}" \
      node --import tsx "${SCRIPT_DIR}/issuer-setup.ts" --help
    exit 0
  fi
done

load_env_file

cluster_override=""
expect_cluster_value=0
for current in "$@"; do
  if [ "${expect_cluster_value}" -eq 1 ]; then
    cluster_override="${current}"
    expect_cluster_value=0
    continue
  fi

  case "${current}" in
    --cluster)
      expect_cluster_value=1
      ;;
    --cluster=*)
      cluster_override="${current#*=}"
      ;;
  esac
done

if [ "${expect_cluster_value}" -eq 1 ]; then
  echo "Missing value for --cluster" >&2
  exit 1
fi

if [ -n "${cluster_override}" ]; then
  CLUSTER="${cluster_override}"
  export CLUSTER
fi

cluster="$(resolve_cluster)"
load_program_ids "${cluster}"

echo "Cluster: ${cluster}"
echo "Security Token Program: ${SECURITY_TOKEN_PROGRAM_ID}"
echo "Transfer Hook Program: ${TRANSFER_HOOK_PROGRAM_ID}"
echo "Transfer Whitelist Program: ${TRANSFER_WHITELIST_PROGRAM_ID}"

TOKEN_ROOT="${TOKEN_ROOT}" \
CLUSTER="${cluster}" \
SECURITY_TOKEN_PROGRAM_ID="${SECURITY_TOKEN_PROGRAM_ID}" \
TRANSFER_HOOK_PROGRAM_ID="${TRANSFER_HOOK_PROGRAM_ID}" \
TRANSFER_WHITELIST_PROGRAM_ID="${TRANSFER_WHITELIST_PROGRAM_ID}" \
node --import tsx "${SCRIPT_DIR}/issuer-setup.ts" "$@"
