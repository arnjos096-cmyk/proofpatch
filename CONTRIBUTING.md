# Contributing

Use Node.js 22+ and Git. Run `npm ci`, then `npm run check`. Run `npm run demo` to inspect a real generated report.

The most useful contributions include reproductions of missed behavioral changes, better representative input domains, more precise import resolution, and accessible report interactions. Add a small temporary Git fixture for analysis changes and an executable before/after module pair for runner changes. Keep receipts explicit about unsupported behavior.

## Code map

- `src/analyzer.ts`: committed snapshots, ASTs, import impact, candidate contracts.
- `src/engine.ts`: contract validation, bounded input generation, execution, shrinking.
- `src/receipt.ts`: verdicts, canonical serialization, integrity, signatures, HTML export.
- `src/cli.ts`: user interface and orchestration.
- `web/`: dependency-free, offline evidence explorer.
- `tests/`: adversarial and integration regressions.

Never make static findings look like executed tests. Never silently execute mined contracts. Never treat a subprocess as a security boundary. Keep generated examples reproducible and label demonstrations accurately.

Open an issue describing a problem before a large feature. Small fixes can go directly to a pull request. Keep changes focused and include `npm run check` results.
