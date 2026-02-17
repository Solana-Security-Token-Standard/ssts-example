#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

load_env_file

cluster="$(resolve_cluster)"

projects=$(verification_projects || true)
if [ -z "${projects}" ]; then
  echo "No verification programs found under verification-programs/."
else
  echo "Building verification programs (cluster=${cluster})..."
  while IFS= read -r project; do
    echo "- ${project}"
    if [ -f "${project}/Cargo.toml" ]; then
      require_cmd cargo
      if cargo --list 2>/dev/null | grep -q "build-sbf"; then
        (cd "${project}" && cargo build-sbf)
      else
        (cd "${project}" && cargo build-bpf)
      fi
    else
      echo "  Skipping (no Cargo.toml)."
    fi
  done <<< "${projects}"
fi

echo "Build complete."
