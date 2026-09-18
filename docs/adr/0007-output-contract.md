# ADR-0007 — Output contract: REST + OpenAPI + static artifacts

**Status:** Accepted · **Date:** 2026-09-17

## Context

The system has two explicit users: a human CFO and an AI accountant that must consume the information programmatically and reason over it. Both matter, and the non-negotiable requirement is that whatever the system claims be explainable.

## Decision

**REST + OpenAPI 3.1** as the single contract, generated from the same Zod schemas that validate responses. Errors as `application/problem+json` (RFC 9457). Cursor pagination.

Plus **static artifacts** per run: `report.md` (CFO), `report.json` (AI), `movements.ndjson` (ledgers for streaming).

Plus, as a cheap bonus, an **MCP server** wrapping the same use cases and returning the same DTOs.

**The underlying thesis:** what an AI needs is not *another protocol*, it is a **stable, self-describing, deterministic schema with quotable IDs and a closed vocabulary of evidence codes**. Well-built REST delivers that. Changing protocol adds nothing; changing the shape of the data does.

Hence every result carries `runId`, `rulesetVersion` and `inputHashes`, and `GET /evidence-codes` publishes the closed vocabulary: an AI can cite `IMPLIED_FEE_IN_BAND` without inventing categories.

## Alternatives considered

| Option | Why not |
|---|---|
| **GraphQL** | Self-describing and pleasant for exploration, but it invites moving logic to the client, complicates caching, and solves nothing REST does not solve here |
| **JSON:API / HAL** | Hypermedia no client of this system will exploit. Ceremony without benefit |
| **gRPC** | Good for machines, but not browser-native and would need a proxy |
| **Artifacts only, no API** | Enough for the deliverable, not enough for the UI |
| **API only, no artifacts** | Forces standing up infrastructure to read a result. Deliverable 9 asks for a readable output |

## Consequences

- The frontend and the AI consume exactly the same truth. There are no "UI-only" endpoints with different logic.
- **The backend does not generate prose.** It emits evidence codes; a `code → phrase` table feeds both `report.md` and the UI. One source of truth, two renderings.
- An evidence code that is emitted but undocumented **breaks the build**. That is what keeps the closed vocabulary honest.
- Fastify compiles the response schema and strips anything undeclared: a domain field that slips through never reaches the wire. The ADR-0010 boundary is protected at runtime too.
- Runs are immutable: they are not overwritten, they are compared. This answers "why did it say something different yesterday?".
