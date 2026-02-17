#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

load_env_file

require_cmd cargo
require_cmd cargo-audit

projects="$(verification_projects || true)"
if [ -z "${projects}" ]; then
  echo "No verification programs found under verification-programs/."
  exit 0
fi

echo "Running cargo-audit for verification programs..."
while IFS= read -r project; do
  [ -f "${project}/Cargo.toml" ] || continue
  echo "- ${project}"
  (
    cd "${project}"
    cargo audit
  )
done <<< "${projects}"

echo "Security audit passed."
