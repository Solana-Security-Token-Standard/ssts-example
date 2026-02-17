---
applyTo: "**"
---

## Read First

1. Read `README.md` before making changes.
2. Treat this repository as a standalone issuer-side SSTS reference implementation.
3. Keep changes aligned with the current repository structure and scripts.

## Project Scope

This repo demonstrates issuer-side usage of deployed SSTS core programs:

- deploy a lightweight verification program (`verification-programs/transfer-whitelist`)
- configure issuer mint and verification setup (`scripts/issuer-setup.ts`)
- run unit and e2e tests (`scripts/test-unit.sh`, `scripts/test-e2e.sh`)

## Current Stack

- Bash entrypoints in `scripts/`
- TypeScript for setup logic and tests
- Rust for verification programs
- Vendored generated clients in `clients/` (temporary, until published packages are adopted)

## Key Paths

- `config/program-ids.json`: cluster-specific `securityTokenProgram`, `transferHookProgram`, `transferWhitelistProgram`
- `scripts/`: build/deploy/setup/test entrypoints
- `tests/e2e/`: chain-state e2e scenarios
- `verification-programs/transfer-whitelist/`: verifier implementation and unit tests
- `config/issuer-state-*.json`: setup output artifacts

## Working Rules

- Keep program IDs externalized to `config/program-ids.json` and CLI/env inputs.
- Do not hardcode deployment-specific IDs in code.
- Keep bash scripts as user-facing entrypoints; use TypeScript for complex transaction assembly.
- Keep scripts fail-fast with actionable error messages.
- If behavior or script flags change, update `README.md` in the same change.
