#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

load_env_file

require_cmd solana

cluster="$(resolve_cluster)"

projects=$(verification_projects || true)
if [ -z "${projects}" ]; then
  echo "No verification programs found under verification-programs/."
  exit 0
fi

echo "Deploying verification programs to ${cluster}..."
while IFS= read -r project; do
  echo "- ${project}"
  deploy_artifacts "${project}" "${cluster}"
  echo "  Deployment done. Update program IDs in config/program-ids.json if needed."
  echo ""
done <<< "${projects}"
