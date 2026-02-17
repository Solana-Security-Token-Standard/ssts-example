#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

load_env_file

require_cmd cargo

projects="$(verification_projects || true)"
if [ -z "${projects}" ]; then
  echo "No verification programs found under verification-programs/."
  exit 0
fi

echo "Formatting Rust code in verification programs..."
while IFS= read -r project; do
  [ -f "${project}/Cargo.toml" ] || continue
  echo "- ${project}"
  cargo fmt --manifest-path "${project}/Cargo.toml" --all
done <<< "${projects}"

echo ""
"${SCRIPT_DIR}/format-check.sh"
