# Spec 00 — Foundations

> Status: 🔨 In progress · Depends on: — · Enables: every phase

## 1. Objective

Leave the skeleton ready so each later phase only adds domain: a monorepo with enforced boundaries, Docker that runs everything locally, versioned configuration, and the test scaffolding.

## 2. Scope

**In:** pnpm workspace, the three packages and three apps with their `package.json` and boundaries; Docker Compose; configuration files; the contract-test harness; logging; error handling; the PII scrubber.

**Out:** any business rule, any parser, any HTTP route beyond `/health`.

## 3. Inputs and outputs

- **Input:** nothing. This is the starting point.
- **Output:** `docker compose up` brings up db + api + web; `make check` passes green on a repo with no logic yet.

## 4. Components to build

### 4.1 Monorepo and boundaries

| Component | Responsibility |
|---|---|
| `pnpm-workspace.yaml` | Declares `apps/*` and `packages/*` |
| `packages/core/package.json` | `dependencies` with **one** entry (`@js-temporal/polyfill`). That near-empty object is the architecture |
| `packages/contracts/package.json` | `zod` only. Does not depend on `@aa/core` |
| `packages/adapters/package.json` | `@aa/core` plus I/O libraries |
| `apps/web/package.json` | `@aa/contracts` plus React. **Nothing else from the backend** |
| `.dependency-cruiser.cjs` | Turns ADR-0010 and ADR-0011 into a build failure |
| `tsconfig.base.json` plus one per package | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |

### 4.2 Versioned configuration (`config/`)

| File | Contents | Consumed by |
|---|---|---|
| `ruleset.v1.json` | Rubric weights, confidence bands, tolerances, settlement window | Phase 2 |
| `holidays-co.json` | Colombian holidays 2025–2026, Ley Emiliani already applied | Phase 2 |
| `descriptors.json` | Bank descriptor patterns → canonical type and counterparty | Phase 1 |
| `odoo-accounts.json` | Canonical type → account code and journal | Phase 3 |
| `sources.json` | Source declarations: id, connector, parser, target account | Phase 1 |

Rule: **no threshold, weight, holiday or account code hardcoded in TypeScript.** Everything loads from here, and `rulesetVersion` travels in every result.

### 4.3 Infrastructure

| Component | Detail |
|---|---|
| `infra/docker-compose.yml` | `db` (postgres:16-alpine, healthcheck, volume), `api`, `web` |
| `infra/compose.dev.yml` | Overlay: bind mounts, Vite HMR, `tsx watch` on the API |
| `infra/Dockerfile.api` | Multi-stage with `pnpm fetch` to cache workspace deps |
| `infra/Dockerfile.web` | Vite build → nginx:alpine serving static files |
| `Makefile` | `up`, `down`, `demo`, `ingest`, `reconcile`, `report`, `test`, `lint`, `check` |

### 4.4 Cross-cutting scaffolding

| Component | Responsibility |
|---|---|
| `packages/adapters/src/composition.ts` | `buildDependencies(config)`: the single composition root, shared by every app. See ADR-0011 |
| `apps/*/env.ts` | Parses and validates that app's environment into a typed `AppConfig` |
| `packages/core/src/testing/` | Per-port contract tests: one suite run against **every** implementation |
| `packages/core/src/domain/errors.ts` | Domain error hierarchy (`ParseIntegrityError`, `SourceUnavailableError`, `AmbiguousMatchError`) |
| `apps/api/src/plugins/error-handler.ts` | Translates domain errors to `application/problem+json` (RFC 9457) |
| Logging | Pino, bundled with Fastify. An `onRequest` hook stamps `runId` into the child logger |
| `scripts/scrub.ts` | Anonymises emails, partial PANs and names before a fixture enters the repo |

### 4.5 Persistence

Postgres, append-only, one row per fact and nothing overwritten. Runs are not replaced, they are compared — which is what lets the system answer "why did it say something different yesterday?".

| Table | Holds |
|---|---|
| `runs` | One row per execution: id, started at, ruleset version, input hashes |
| `raw_records` | The bytes as received, with their content hash |
| `movements` | The canonical ledger, keyed by content-derived id |
| `batches` | Settlement batches and their deductions |
| `matches` | Channel-to-bank results with evidence and alternatives |

Every table carries `run_id`. Upserts are keyed on the deterministic ids, so re-running an ingestion is a no-op rather than a duplication.

**Two ports are still missing:** `BatchRepository` and `MatchRepository`. Phase 2 currently computes a report and returns it in memory, with nowhere to put what it produced.

**The `runId` lifecycle is undecided.** The type exists and travels through every result, but nothing creates or closes a run yet. That has to be settled before the API can serve more than one.

**Testing against a real database.** Contract suites have to run against Postgres or they prove nothing, which collides with domain tests staying Docker-free. The scripts split:

```
pnpm test              → unit and domain, in-memory, milliseconds, no Docker
pnpm test:integration  → contract suites against a real Postgres
make check             → both
```

Testcontainers starts and disposes a container per run, so integration tests never depend on someone having run `make up` first, and never leave state behind. The cost is that `test:integration` needs Docker running; the everyday fast path does not.

### 4.6 The contract-test harness

This is what makes the whole ports-and-adapters strategy safe. For each port we write **one** suite describing expected semantics — ordering, idempotency, empty-range behaviour, error handling — and run it against every implementation, real and fixture-backed. The day a `SapErpGateway` appears, adding one line tells us whether it genuinely honours the contract, including semantics no type system can express.

## 5. Settled decisions

1. **TypeScript**, not Java (ADR-0001). The full analysis, including where Java was genuinely better, is in the ADR.
2. **Three packages**: `core` (domain), `adapters` (outside world), `contracts` (the wire). `persistence` is a folder inside `adapters`, not a package (ADR-0011).
3. **`core` has exactly one dependency**: `@js-temporal/polyfill`, as a date primitive rather than infrastructure. Declared, not smuggled in.
4. **CLI included.** Not required by the brief — it says "interface, CLI, other…" — but deliverable 9 needs a headless generator for `report.md`/`report.json`, ingestion is batch by nature, and with `node:util parseArgs` it costs ~100 lines and zero dependencies.
5. **Postgres, not SQLite.** Docker is already there; domain tests do not need it because they use in-memory repositories.
6. **Language split:** code and docs in English, human-facing product output in `es-AR`.

## 6. Environment variables

Those in `.env.example`, grouped into application, persistence, Wompi, Odoo and frontend. Detail in [ENVIRONMENT.md](../ENVIRONMENT.md).

`SOURCE_MODE` is the most important variable in the project: in `fixtures` the system runs end to end with no credentials and no network.

## 7. Tests

| ID | Type | Verifies |
|---|---|---|
| F00-T01 | Architecture | `apps/web` cannot import `@aa/core` or `@aa/adapters` |
| F00-T02 | Architecture | `packages/core` imports no npm package except the Temporal polyfill |
| F00-T03 | Architecture | No dependency cycles |
| F00-T04 | Unit | Every `config/` file validates against its Zod schema at boot; a corrupt JSON fails startup with a clear message |
| F00-T05 | Integration | `GET /health` returns 200 with version and `rulesetVersion` |
| F00-T06 | Integration | A domain error surfaces as `problem+json` with `type`, `title`, `status`, `detail` |
| F00-T07 | Unit | `scripts/scrub` replaces emails and partial PANs stably (same input, same pseudonym) |
| F00-T08 | Smoke | `docker compose up` leaves all three services healthy |

## 8. Definition of done

- [x] Workspace, the three packages and three apps, with their dependency boundaries.
- [x] A deliberate attempt to import `@aa/core` from `apps/web` **breaks the build** (§8.1).
- [x] All five `config/` files exist.
- [x] `.env` is gitignored; `.env.example` contains no real values.
- [ ] Zod schemas validating each `config/` file at boot.
- [ ] `docker compose up` brings up db, api and web; `/health` responds and the web app loads.
- [ ] `scripts/scrub.ts` and its test.
- [ ] No file under `data/fixtures/` contains unscrubbed PII.

### 8.1 Boundary enforcement, verified

The rule was tested rather than assumed, and the first version **did not fire**. Both realistic violations are now caught:

| Scenario | Result |
|---|---|
| `apps/web` imports `@aa/core` without declaring the dependency | `error no-unresolvable: apps/web/… → @aa/core` |
| `apps/web` declares `@aa/core` in its `package.json`, then imports it | `error web-only-touches-contracts: apps/web/… → packages/core/src/index.ts` |

The second one is the realistic case — someone who wants the domain would add the dependency first — and it originally slipped through: workspace packages export TypeScript source directly, and depcruise's default resolver could not follow the `exports` field to a `.ts` file, so the import surfaced as "unresolvable" rather than as the boundary violation it was. Fixed with `enhancedResolveOptions` in `.dependency-cruiser.cjs`.

Worth recording because it is the whole point of ADR-0010: a boundary that is only written down is not a boundary.

## 9. How it is demonstrated

```
make up      →  three healthy containers
make check   →  lint + boundaries + typecheck + tests, green
```

**Note on pnpm:** the repo pins `pnpm@9.12.0` via `packageManager`. Where pnpm is not installed globally, `corepack pnpm <command>` works without an install (Node 22 ships corepack). `corepack enable pnpm` needs administrator rights on Windows.

## 10. Open questions

None blocking. This is the only phase that depends on no external data, which is why it goes first.
