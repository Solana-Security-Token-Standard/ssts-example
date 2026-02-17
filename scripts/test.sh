#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Running unit tests..."
"${SCRIPT_DIR}/test-unit.sh"

echo ""
echo "Running e2e tests..."
"${SCRIPT_DIR}/test-e2e.sh"
