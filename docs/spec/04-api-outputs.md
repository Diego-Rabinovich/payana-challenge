# Spec 04 — API and outputs (the CFO and the AI)

> Status: 🔨 Core implemented · Depends on: [02](02-phase2-flow.md), [03](03-phase3-erp.md) · Enables: [05](05-frontend.md), [06](06-ai-user.md)

## 1. Objective

Expose results to the challenge's **two users** through a single contract: a CFO who reads and an AI accountant that reasons programmatically.

## 2. Scope

**In:** the REST API with generated OpenAPI, domain → DTO presenters, static artifacts (`report.md`, `report.json`), error handling and the run model.

**Out:** the UI (Spec 05) and the MCP server (Spec 06).

## 3. The thesis

What an AI needs is **not another protocol**: it is a stable, self-describing, deterministic schema with quotable IDs and a closed vocabulary of evidence codes. Well-built REST delivers that. Changing protocol adds nothing; changing the shape of the data does.

Alternatives evaluated and rejected: GraphQL (self-describing, but invites moving logic to the client and adds infrastructure), JSON:API/HAL (hypermedia no client here exploits), gRPC (not browser-native). See ADR-0007.

## 4. Components to build

### 4.1 Contracts (`packages/contracts/`)

Zod schemas for the DTOs: `MovementDto`, `LedgerSummaryDto`, `SettlementBatchDto`, `ReconciliationDto`, `EvidenceDto`, `LineageDto`, `ErpReconciliationLineDto`, `ProposedEntryDto`, `RunSummaryDto`, `ProblemDto` (RFC 9457).

From that single definition come: backend request/response validation, JSON Schema for the AI, OpenAPI for documentation, and types for the frontend.

### 4.2 Presenters (`apps/api/src/presenters/`)

The explicit domain → DTO mapping. This is where the internal model is protected from being shaped by the wire format. Some DTOs will closely resemble their entity: not accidental duplication, but what lets each evolve separately.

### 4.3 Endpoints

| Method and route | Returns |
|---|---|
| `GET /health` | Version, `rulesetVersion`, source status |
| `GET /runs` · `POST /runs` · `GET /runs/{runId}` | Runs. `POST` replies `201` with `Location` |
| `GET /runs/{runId}/report?format=md\|json` | The run artifact. JSON is `RunReportDto` |
| `GET /accounts` · `GET /accounts/{accountId}/movements` | Accounts and cursor-paginated movements |
| `GET /movements/{movementId}` · `GET /movements/{movementId}/lineage` | Movement and where its money went |
| `GET /runs/{runId}/summary` | The funnel and the counts the panel is built from |
| `GET /runs/{runId}/settlement-batches` · `/{batchId}` | Batches |
| `GET /runs/{runId}/reconciliations?status=ambiguous` | Channel-to-bank results, filterable |
| `GET /runs/{runId}/reconciliations/{matchId}` | Detail with evidence and alternatives |
| `GET /runs/{runId}/unattributed-credits` | Credits no batch claimed |
| `GET /runs/{runId}/erp-reconciliations/{journalKey}` | ERP reconciliation, each line with its proposed correction |
| `GET /runs/{runId}/channels` | Connected sources and what that run measured |
| `POST /erp-journal-entries` | Creates one missing entry as a draft, from the correction a run found |
| `GET /evidence-codes` | The closed vocabulary with descriptions |
| | |
| **Why the nesting** | A match id is stable across runs on purpose, so it names a pairing and not a result: the same id can carry a different score under a different run. A flat `/reconciliations/{id}` therefore identified a family of representations, disambiguated by an optional `?runId` that defaulted to whichever run happened last — so a detail stored in an older run answered 404 while that run's own list showed it. `latest` is a valid `{runId}` and the server resolves it, so "the most recent" stays expressible without ever being implicit. The ledger stays flat: a movement id is a content hash and belongs to no run. |
| `POST /sources/{sourceId}/documents` | Uploads a monthly statement (multipart) |

**Every path names a resource, never an action.** A movement's provenance is
`/movements/{id}/lineage`, a sub-resource — not `/trace`. Creating the missing
entries posts to the `erp-journal-entries` collection rather than to a
`post-missing` endpoint. And there is no `dryRun` flag anywhere: the preview is
already a different resource, since `GET /runs/{runId}/erp-reconciliations/{journalKey}`
returns every `proposedEntry` before anything is written. A test asserts that no
published path matches a verb.

### 4.4 Cross-cutting API rules

1. **Every result carries `runId`, `rulesetVersion` and `inputHashes`.** Without them a result is neither reproducible nor auditable.
2. **Errors as `application/problem+json`** (RFC 9457): `type`, `title`, `status`, `detail`, `instance`.
3. **Cursor pagination**, not offset: ledgers are long and grow.
4. **Stable, quotable IDs** in every response. An AI must be able to refer to `mov_9c21` and have it always mean the same thing.
5. **Responses stripped to the schema.** Fastify compiles the response schema; a domain field that slips through never reaches the wire. The ADR-0010 boundary, enforced at runtime.

### 4.5 Static artifacts

Each run writes to `data/out/`:

| File | For whom | Contents |
|---|---|---|
| `report.md` | CFO | Executive summary, money funnel, exceptions ranked by amount at risk, and each one's detail in prose assembled from evidence codes |
| `report.json` | AI | The same content, structured, with IDs, evidence, confidence and alternatives |

They matter because they are consumable **without starting the server**, they version and they diff. And they are deliverable 9.

### 4.6 How prose is assembled

The backend **does not generate text**. It emits `Evidence[]` with codes; a `code → phrase` table renders them. One source of truth — the codes — and two renderings, `report.md` and the UI. No duplicated prose, no presentation logic in the domain.

Output locale is `es-AR`, formal register, with Argentine number formatting.

### 4.7 Structure of the CFO report

1. **Headline:** the period, how much was expected, how much arrived, how much is missing.
2. **Funnel:** gross sales → fees → VAT → withholdings → expected net → credited → difference.
3. **Traffic light:** count and amount by status.
4. **Exceptions**, ranked by amount at risk, each with a one-sentence explanation and its evidence below.
5. **ERP:** line-by-line discrepancies with their proposed correction.
6. **Unattributed:** bank credits that are not Wompi's, classified.
7. **Appendix:** ruleset version, input hashes, timestamp. Without this the report is not auditable.

## 5. Settled decisions

1. **REST plus OpenAPI 3.1 as the single contract**, generated from the same Zod schemas.
2. **Static artifacts alongside the API**, because the deliverable must be readable without infrastructure.
3. **Evidence codes as a closed, documented vocabulary.** That is what lets an AI cite without inventing.
4. **Runs are immutable and append-only.** Not overwritten, compared. Answers "why did it say something different yesterday?".

## 6. Environment variables

`PORT`, `LOG_LEVEL`, `VITE_API_BASE_URL` (for CORS), `DATA_DIR` (artifact destination).

## 7. Tests

| ID | Type | Verifies |
|---|---|---|
| F04-T01 | Integration | Every endpoint returns a body validating against its DTO (via `app.inject()`) |
| F04-T02 | Integration | A domain field not declared in the DTO **does not appear** in the response |
| F04-T03 | Integration | A domain error becomes `problem+json` with the five RFC 9457 fields |
| F04-T04 | Integration | Cursor pagination: walking every page yields the exact total, no repeats, no gaps |
| F04-T05 | Contract | The generated `openapi.json` validates against the OpenAPI 3.1 meta-schema |
| F04-T06 | Contract | `GET /schema` exposes valid JSON Schema for every DTO |
| F04-T07 | Unit | Every `EvidenceCode` emitted by Phases 2 and 3 exists in `/evidence-codes`. **An undocumented code breaks the build** |
| F04-T08 | Golden | `report.md` and `report.json` over fixtures → snapshot |
| F04-T09 | Reproducibility | Two runs produce **byte-identical** `report.json` apart from timestamp and `runId` |
| F04-T10 | Unit | `report.json` contains `rulesetVersion` and the input hashes |
| F04-T11 | Integration | `POST /sources/{id}/upload` with a corrupt PDF → 422 with detail, no state corruption |

## 8. Definition of done

- [ ] `openapi.json` is generated automatically and Swagger UI is served at `/docs`.
- [ ] Every claim in `report.md` has a structured equivalent in `report.json`, sharing IDs.
- [ ] A reader holding only `report.json` can reconstruct the full reasoning without API access.
- [ ] F04-T09 passes: the system is reproducible.
- [ ] Every evidence code is documented.
- [ ] No endpoint returns an error outside RFC 9457 format.

## 9. How it is demonstrated

```
make demo          # writes the three artifacts to data/out/
curl localhost:3000/api/v1/runs/latest/reconciliations?status=ambiguous
open localhost:3000/docs
```

## 10. Open questions

- **Q4.1 — Authentication?** Not for a local challenge. If asked for, a header API key is half an hour.
- **Q4.2 — Should `POST /runs` be synchronous or queued?** At this volume, synchronous with a generous timeout is enough. If a run exceeds ~30s, return `202` plus a `runId` to poll.
