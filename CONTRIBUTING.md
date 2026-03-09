# Contributing

Thanks for contributing to this project.

## Scope

This repository is a reference issuer implementation for SSTS. Useful contributions include:

- bug fixes
- clearer docs and examples
- tests and reliability improvements
- script and developer-experience improvements

## Development Setup

1. Install requirements from `README.md`.
2. Install dependencies:

```bash
npm install
cp .env.example .env
```

3. Configure `config/program-ids.json` and `.env` for your target cluster when running e2e flows.

## Validation Before PR

Run these locally before opening a pull request:

```bash
npm run typecheck
npm run format:check
npm run clippy
npm run audit
npm run test:unit
```

For cluster-backed verification, also run:

```bash
CLUSTER=devnet npm run test:e2e
```

## Pull Request Guidelines

1. Keep changes focused and small.
2. Add or update tests for behavior changes.
3. Update docs (`README.md`, `CONTRIBUTING.md`, script help text, or comments) when interfaces or workflow change.
4. Describe what changed, why it changed, and how it was validated.

## Security Issues

Do not post sensitive vulnerabilities publicly in issues with exploit details. Open an issue with minimal detail and request a private contact path from maintainers.

## License

By contributing, you agree that your contributions are licensed under MIT (`LICENSE.md`).
