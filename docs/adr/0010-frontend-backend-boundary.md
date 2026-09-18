# ADR-0010 — Front/back boundary: a shared `contracts` package

**Status:** Accepted · **Date:** 2026-09-17

## Context

Monorepo with front and back in the same language.

Two things get conflated and are worth separating:

- **Sharing the domain** (`core`): unacceptable. If the frontend can import `ReconcileFlow` or `MatchingRule`, sooner or later there is reconciliation logic in the browser and two implementations of the same rule drifting apart.
- **Sharing the contract**: Front and back *always* agree on the shape of the JSON; the only question is whether that agreement is written once or twice.

Also: **a monorepo is not one application.** `api` and `web` remain two processes, two containers and two deploys, communicating only over HTTP. A TypeScript type is erased at compile time and creates no runtime dependency.

## Decision

An `@aa/contracts` package holding **only Zod DTOs**, consumed by `apps/web` and `apps/api`. Coupling equivalent to generating a client from `openapi.json`, with fewer moving parts.

And because a shared package erodes silently, hard rules enforced by `dependency-cruiser` in CI:

| Rule | Reason |
|---|---|
| `apps/web` may import only `@aa/contracts` | If it can import `core`, the boundary is dead |
| `@aa/contracts` imports from **nobody**, not even `core` | Zero dependencies means zero erosion |
| `@aa/contracts` holds only DTOs and enums: no functions, no classes | When someone tries to slip a helper in, lint stops them |
| `core` does not know `contracts` | The domain is not shaped by the wire format |
| Domain → DTO mapping lives in `apps/api/presenters/` | Explicit, reviewable translation |

## Alternatives considered

- **Codegen from OpenAPI** (`openapi-typescript`). Identical coupling, but **impossible to erode** because the artifact is generated. It is the more orthodox option and stays as the migration plan: we switch if the backend moves to Java, if front and back split into separate repos, or if a non-TypeScript consumer appears. It is one build step of difference, not an architectural change.
- **Sharing nothing**, with hand-written interfaces in the frontend. The industry default and the worst option: types drift silently from the real backend.

## Consequences

- `apps/web/package.json` shows, in five lines, that the frontend cannot reach the domain. No README to read, no one to trust.
- **Honest cost:** some DTOs will closely resemble their domain entity and require a dull mapper. That is not accidental duplication: it is what lets the internal `MatchResult` evolve without breaking the public API.
- Fastify strips responses down to the declared schema, so the boundary is protected twice: by lint at build time and by the serialiser at runtime.
