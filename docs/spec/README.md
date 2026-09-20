# Specifications — index and conventions

Each phase has a spec. A spec states **what gets built**, **how it is tested** and **when it is done**. It carries no code: it carries settled decisions and verifiable criteria, so implementation is mechanical and the arguing happens here.

| # | Spec | Depends on | Status |
|---|---|---|---|
| 00 | [Foundations](00-foundations.md) — monorepo, Docker, config, test harness | — | 🔨 In progress |
| 01 | [Phase 1 — Canonical model and ingestion](01-phase1-ingestion.md) | 00 | 🔨 In progress |
| 02 | [Phase 2 — Channel-to-bank reconciliation](02-phase2-flow.md) | 01 | 🔨 Core implemented |
| 03 | [Phase 3 — Ledger-to-ERP reconciliation](03-phase3-erp.md) | 01 | 🔨 Core implemented |
| 04 | [API and outputs](04-api-outputs.md) | 02, 03 | 🔨 Core implemented |
| 05 | [CFO frontend](05-frontend.md) | 04 | 🔨 Core implemented |
| 06 | [The AI user](06-ai-user.md) — agent-legible repo, MCP server | 04 | ✅ Done |

**Status:** 📝 Draft → 🔒 Frozen (agreed, being implemented) → 🔨 In progress → ✅ Done (DoD verified).

---

## Shape of a spec

1. **Objective** — which question this phase answers, in one sentence.
2. **Scope** — what is in and, above all, what is **out**.
3. **Inputs and outputs** — what data it starts from and what it produces.
4. **Components to build** — a table of everything to be written, one line of responsibility each.
5. **Settled decisions** — what is resolved and will not be relitigated during implementation.
6. **Configuration and environment** — what this phase introduces.
7. **Tests** — id, type and what each one verifies.
8. **Definition of done** — a verifiable checklist.
9. **How it is demonstrated** — the actual command and the expected output.
10. **Open questions** — what remains unconfirmed, and who can answer it.

## Global definition of done

No phase is finished without all of this:

- [ ] `make check` passes: lint + `dependency-cruiser` + typecheck + tests.
- [ ] Every business rule in the phase has at least one test proving it and one proving its negative case.
- [ ] The phase runs under **`SOURCE_MODE=fixtures`**, with no credentials and no network.
- [ ] Any new data entering the repo went through the PII scrub.
- [ ] New assumptions are written down: an ADR if structural, section 10 of the spec if a doubt.
- [ ] No `TODO`, `any` or `@ts-ignore` without a comment explaining why.

## Cross-cutting conventions

- **Money:** integer COP cents inside `Money`. Never a bare `number`, never a float.
- **Dates:** `Temporal.PlainDate` for accounting dates, `Temporal.Instant` for timestamps. Business timezone: `America/Bogota`.
- **IDs:** deterministic, derived from content. Re-ingesting does not duplicate.
- **Errors:** the domain throws typed errors; the API translates them to RFC 9457. Nothing is swallowed.
- **Config over code:** thresholds, weights, holidays, descriptor patterns and the account map live in versioned `config/*.json`. Changing a tolerance is not a code deploy.
- **Language:** code, comments, documentation and identifiers in English. Anything a human reads in the product — `report.md`, UI copy, evidence phrases — in `es-AR`, formal register.
- **No library mocking:** we mock **ports**, never `fetch` or `pg`.
