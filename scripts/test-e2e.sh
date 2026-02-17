#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

load_env_file

require_cmd node

cluster="$(resolve_cluster)"
load_program_ids "${cluster}"

echo "Cluster: ${cluster}"
echo "Security Token Program: ${SECURITY_TOKEN_PROGRAM_ID}"
echo "Transfer Hook Program: ${TRANSFER_HOOK_PROGRAM_ID}"
echo "Transfer Whitelist Program: ${TRANSFER_WHITELIST_PROGRAM_ID}"

echo ""
echo "Checking program accounts on chain..."
SECURITY_TOKEN_PROGRAM_ID="${SECURITY_TOKEN_PROGRAM_ID}" \
TRANSFER_HOOK_PROGRAM_ID="${TRANSFER_HOOK_PROGRAM_ID}" \
TRANSFER_WHITELIST_PROGRAM_ID="${TRANSFER_WHITELIST_PROGRAM_ID}" \
CLUSTER="${cluster}" \
node --input-type=module <<'EOF'
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";

const cluster = process.env.CLUSTER || "devnet";
const securityId = process.env.SECURITY_TOKEN_PROGRAM_ID;
const hookId = process.env.TRANSFER_HOOK_PROGRAM_ID;
const whitelistId = process.env.TRANSFER_WHITELIST_PROGRAM_ID;
const url =
  process.env.SOLANA_RPC_URL ||
  (cluster === "localnet"
    ? "http://127.0.0.1:8899"
    : clusterApiUrl(cluster === "mainnet" ? "mainnet-beta" : cluster));

const connection = new Connection(url, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});
const ids = [securityId, hookId, whitelistId];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryable(error) {
  const message = String(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("gateway timeout") ||
    message.includes("service unavailable")
  );
}

async function getAccountInfoWithRetry(key) {
  let delayMs = 300;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return await connection.getAccountInfo(key, "confirmed");
    } catch (error) {
      if (!retryable(error) || attempt === 8) {
        throw error;
      }
      await sleep(delayMs);
      delayMs = Math.min(Math.floor(delayMs * 1.8), 4000);
    }
  }
  return null;
}

for (const id of ids) {
  const key = new PublicKey(id);
  const info = await getAccountInfoWithRetry(key);
  if (!info) {
    console.error("Program account not found: " + id + " on " + cluster);
    process.exit(1);
  }
  if (!info.executable) {
    console.error("Account is not executable: " + id + " on " + cluster);
    process.exit(1);
  }
  console.log("OK: " + id);
}
EOF

echo ""
echo "Running e2e tests..."
if [ ! -d "${TOKEN_ROOT}/node_modules" ]; then
  echo "Installing npm dependencies..."
  (cd "${TOKEN_ROOT}" && npm install)
fi

test_target="${E2E_TEST_TARGET:-${TOKEN_ROOT}/tests/e2e}"
test_files=()
while IFS= read -r test_file; do
  test_files+=("${test_file}")
done < <(find "${test_target}" -type f -name "*.test.ts" | sort)

if [ "${#test_files[@]}" -eq 0 ]; then
  echo "No e2e test files found under ${test_target}" >&2
  exit 1
fi

RUN_SSTS_E2E=1 CLUSTER="${cluster}" node --import tsx --test --test-concurrency=1 "${test_files[@]}"
