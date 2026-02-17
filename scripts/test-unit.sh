#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

load_env_file

TOKEN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

require_cmd node

run_rust_tests="${RUN_RUST_TESTS:-1}"
if [ "${run_rust_tests}" = "1" ]; then
  projects="$(verification_projects || true)"
  if [ -n "${projects}" ]; then
    require_cmd cargo
    echo "Running Rust verification program unit tests..."
    while IFS= read -r project; do
      [ -f "${project}/Cargo.toml" ] || continue
      echo "- ${project}"
      cargo test --manifest-path "${project}/Cargo.toml" --features no-entrypoint
    done <<< "${projects}"
  fi
fi

if [ ! -d "${TOKEN_ROOT}/node_modules" ]; then
  echo "Installing npm dependencies..."
  (cd "${TOKEN_ROOT}" && npm install)
fi

unit_test_target="${UNIT_TEST_TARGET:-${TOKEN_ROOT}/tests}"
unit_test_files=()
while IFS= read -r test_file; do
  unit_test_files+=("${test_file}")
done < <(find "${unit_test_target}" -type f -name "*.test.ts" ! -path "*/e2e/*" | sort)

if [ "${#unit_test_files[@]}" -eq 0 ]; then
  echo "No TypeScript unit/integration tests found outside tests/e2e under ${unit_test_target}."
  echo "Rust verification program unit tests completed."
  exit 0
fi

echo "Running TypeScript unit/integration tests..."
node --import tsx --test --test-concurrency=1 "${unit_test_files[@]}"
