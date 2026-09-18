# ADR-0011 — Three packages, and `core` with a single dependency

**Status:** Accepted · **Date:** 2026-09-17

## Context
The backend is `core` + `adapters`. The API is the HTTP mechanism that exposes it; the CLI is another.

## Decision

Three packages, three concepts:

| Package | What it is | `dependencies` |
|---|---|---|
| `@aa/core` | The domain | `@js-temporal/polyfill` **and nothing else** |
| `@aa/adapters` | The outside world (`wompi/`, `bancolombia/`, `odoo/`, `persistence/`, `fs/`, `http/`) | `@aa/core` plus I/O libraries |
| `@aa/contracts` | The wire | `zod` |

**`persistence` is not a package**, it is a folder inside `adapters`: a repository is a driven adapter exactly like `OdooErpGateway`. Fewer pieces, same isolation.

## Alternatives considered

- **Everything inside `apps/api`** (`src/{domain,application,infrastructure}`). Perfectly defensible **if there were no CLI** and the API were the only door. Not dogma; what tips the balance is the sum of three doors, the workspace, and enforcement being mechanical rather than aspirational.
- **Four packages** (`persistence` separate). More ceremony, no extra isolation.
- **One package per adapter** (`adapters-wompi`, `adapters-odoo`…). Over-engineering. They are folders.
- **`core` with a strict `dependencies: {}`**, hand-writing date arithmetic. Roughly 40 lines of subtle, edge-case-ridden code that adds nothing to the challenge.

## The composition root lives in `adapters`

Binding ports to concrete implementations — `MovementRepository` to Postgres, `ErpGateway` to Odoo or to fixtures, the ruleset to a JSON file — happens in one place. With a single door that place is naturally inside the app. With three (API, CLI, MCP) it cannot be, because `apps` may not import each other, so the wiring would be copy-pasted three times.

The cost is not the duplication, it is the **drift**. If the CLI keeps building a fixture gateway after the API moved to a live one, `make demo` and the API report different numbers for the same data — and "same inputs, same ruleset version, same result" is the promise the whole system rests on. It would break quietly, and no test would catch it.

So `buildDependencies(config)` lives in `packages/adapters/src/composition.ts`, and each app is about twenty lines: read its environment, call it, start.

Assembling adapters is what `adapters` is for, and it is the only layer that can see both the ports and the concrete implementations. The purist objection — that a composition root belongs in the outermost ring because it knows the deployment context — is answered by splitting it: each app parses and validates its own environment into a typed `AppConfig` (the API needs `PORT`, the CLI does not), and `adapters` only assembles from that. It never reads `process.env`.

## Consequences

- The dependency graph reads at a glance across five `package.json` files.
- `dependency-cruiser` has a rule allowing exactly one npm package inside `core`; any other breaks the build.
- During development there is no build step between packages: with `exports` pointing at `src`, `tsx watch` and Vite resolve workspace TypeScript directly. A separate build happens only in `docker build`.
