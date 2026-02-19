#!/usr/bin/env bash
set -euo pipefail

TOKEN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_CLUSTER="devnet"

resolve_cluster() {
  local cluster="${CLUSTER:-$DEFAULT_CLUSTER}"
  case "${cluster}" in
    localnet|devnet|testnet|mainnet)
      echo "${cluster}"
      ;;
    *)
      echo "Unsupported CLUSTER=${cluster}. Expected localnet|devnet|testnet|mainnet." >&2
      exit 1
      ;;
  esac
}

config_path() {
  echo "${TOKEN_ROOT}/config/program-ids.json"
}

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
}

load_env_file() {
  local env_file="${ENV_FILE:-${TOKEN_ROOT}/.env}"
  if [ -f "${env_file}" ]; then
    echo "Loading environment from ${env_file}"
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
  fi
}

read_program_id() {
  local cluster="$1"
  local key="$2"
  local cfg
  cfg="$(config_path)"

  node --input-type=module -e "import fs from 'fs';
const configPath = process.argv[1];
const cluster = process.argv[2];
const key = process.argv[3];
const raw = fs.readFileSync(configPath, 'utf8');
const parsed = JSON.parse(raw);
const entry = parsed[cluster];
if (!entry || !entry[key]) {
  console.error('Missing ' + key + ' for ' + cluster + ' in ' + configPath);
  process.exit(1);
}
console.log(entry[key]);" "${cfg}" "${cluster}" "${key}"
}

load_program_ids() {
  local cluster="$1"
  SECURITY_TOKEN_PROGRAM_ID="$(read_program_id "${cluster}" "securityTokenProgram")"
  TRANSFER_HOOK_PROGRAM_ID="$(read_program_id "${cluster}" "transferHookProgram")"
  TRANSFER_WHITELIST_PROGRAM_ID="$(read_program_id "${cluster}" "transferWhitelistProgram")"
  export SECURITY_TOKEN_PROGRAM_ID TRANSFER_HOOK_PROGRAM_ID TRANSFER_WHITELIST_PROGRAM_ID
}

cluster_url() {
  if [ -n "${SOLANA_RPC_URL:-}" ]; then
    echo "${SOLANA_RPC_URL}"
    return
  fi

  case "$1" in
    localnet)
      echo "http://127.0.0.1:8899"
      ;;
    devnet)
      echo "https://api.devnet.solana.com"
      ;;
    testnet)
      echo "https://api.testnet.solana.com"
      ;;
    mainnet)
      echo "https://api.mainnet-beta.solana.com"
      ;;
    *)
      echo ""
      ;;
  esac
}

verification_projects() {
  if [ ! -d "${TOKEN_ROOT}/verification-programs" ]; then
    return 0
  fi
  local dir
  for dir in "${TOKEN_ROOT}/verification-programs"/*; do
    [ -d "${dir}" ] || continue
    if [ -f "${dir}/Cargo.toml" ]; then
      echo "${dir}"
    fi
  done
}

deploy_artifacts() {
  local root="$1"
  local cluster="$2"
  local deploy_dir="${root}/target/deploy"

  if [ ! -d "${deploy_dir}" ]; then
    echo "No build artifacts found in ${deploy_dir}. Run scripts/build.sh first." >&2
    return 1
  fi

  local so_files=("${deploy_dir}"/*.so)
  if [ ! -e "${so_files[0]}" ]; then
    echo "No .so artifacts found in ${deploy_dir}. Run scripts/build.sh first." >&2
    return 1
  fi

  local url
  url="$(cluster_url "${cluster}")"

  local so keypair
  for so in "${so_files[@]}"; do
    keypair="${so%.so}-keypair.json"
    if [ -f "${keypair}" ]; then
      solana program deploy "${so}" --program-id "${keypair}" --url "${url}"
    else
      solana program deploy "${so}" --url "${url}"
    fi
  done
}
