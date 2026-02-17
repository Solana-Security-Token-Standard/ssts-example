# SSTS Issuer Example

Reference issuer project for the SSTS core programs.

This repository demonstrates how to:

- deploy a lightweight transfer-whitelist verification program
- configure SSTS verification for mint and transfer
- issue a Token-2022 mint through SSTS
- run end-to-end tests for transfer verification behavior

## Overview

The core SSTS programs are expected to already be deployed. This repo focuses on the issuer side:

- issuer setup automation (`scripts/issuer-setup.ts`, pure `@solana/kit`)
- custom verification program (`verification-programs/transfer-whitelist`)
- end-to-end tests (`tests/e2e`)

The `clients/` folder is currently copied from core and used locally until published packages are available.

## Repository Layout

- `scripts/`: build, deploy, setup, and test entrypoints
- `verification-programs/`: custom verification programs
- `clients/`: generated TypeScript SSTS clients
- `config/`: cluster program IDs and setup artifacts
- `idl/`: core SSTS IDL used by generated clients
- `tests/`: test suite (`tests/e2e` contains chain-state tests)

## Requirements

- Node.js 20+
- npm
- Solana CLI (configured signer)
- Rust toolchain + Solana SBF tooling (`cargo build-sbf`) for program builds
- Access to the target cluster RPC

## Installation

```bash
npm install
cp .env.example .env
```

## Quick Start

```bash
# 1) Build verification programs
npm run build

# 2) Deploy verification program (cluster defaults to devnet)
CLUSTER=devnet npm run deploy:verification

# 3) Update config/program-ids.json with deployed transferWhitelistProgram
#    and confirm securityTokenProgram / transferHookProgram are correct

# 4) Optional: run e2e checks
CLUSTER=devnet npm run test:e2e

# 5) Setup issuer state and issue token configuration
CLUSTER=devnet npm run issuer:setup
```

## Configuration

### Program IDs

Set cluster-specific values in `config/program-ids.json`:

- `securityTokenProgram`
- `transferHookProgram`
- `transferWhitelistProgram`

### Setup Inputs

Defaults are in `.env.example`. Main options include:

- token metadata (`TOKEN_NAME`, `TOKEN_SYMBOL`, optional `TOKEN_URI`)
- mint parameters (`TOKEN_DECIMALS`, `INITIAL_MINT_AMOUNT`)
- recipient and whitelist bootstrap settings
- payer funding behavior on devnet and localnet

You can inspect all setup options with:

```bash
npm run issuer:setup -- --help
```

CLI flags override `.env` values.

## Scripts

| Command                       | Description                                   |
| ----------------------------- | --------------------------------------------- |
| `npm run build`               | Build verification programs                   |
| `npm run deploy:verification` | Deploy verification programs                  |
| `npm run issuer:setup`        | Initialize issuer mint/config/whitelist state |
| `npm run format`              | Format Rust verifier code                     |
| `npm run format:check`        | Check Rust formatting                         |
| `npm run clippy`              | Run clippy on Rust verifier code              |
| `npm run audit`               | Run cargo-audit for verifier dependencies     |
| `npm run test:unit`           | Run Rust verifier unit tests + TS non-e2e     |
| `npm run test:e2e`            | Run chain-state end-to-end tests              |
| `npm test`                    | Run `test:unit` then `test:e2e`               |

## Testing

Use `npm run test:unit` for fast local checks that do not require deployed on-chain programs.

Use `npm run test:e2e` for cluster-backed checks. It requires valid program IDs in `config/program-ids.json` and reachable RPC.

Use `npm test` to run both in sequence.

The e2e suite is split into named tests and covers:

- introspection-mode verification path
- cpi/hook path account-context validation
- whitelist add/remove behavior
- malformed and missing context failures

## Output Artifact

`issuer:setup` writes state to:

- default: `config/issuer-state-<cluster>.json`
- override: `ISSUER_STATE_PATH`

## TODO

- Change `config/program-ids.json` values after final program deployments.
- Replace vendored `clients/` with published client packages once available.

## Contributing

Contributions are welcome. See `CONTRIBUTING.md` for setup, validation checks, and pull request guidelines.

## License

MIT. See `LICENSE.md`.
