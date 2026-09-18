# Spec 05 — Frontend: the CFO console

> Status: 📝 Draft · Depends on: [04](04-api-outputs.md)

## 1. Objective

Let a busy CFO understand, painlessly, what happened to their money — and audit any claim the system makes all the way down to the row of the PDF it came from.

## 2. Guiding principle

**The default view is not the data, it is what does not add up.** Nobody wants a 3,000-row table; they want the seven things that look wrong. It is the lesson of the Xero and QuickBooks reconciliation screens: the tool is an **exceptions inbox**, not a movement viewer.

The design corollary: every important number is clickable and descends one level, down to the `RawRecord`.

## 3. Scope

**In:** five screens, the evidence component, statement upload, and the empty and error states.

**Out:** authentication, multi-user, movement editing, charts beyond the funnel.

## 4. Stack

React 19 + Vite + TypeScript, TanStack Query for server state, TanStack Table for grids, Tailwind + shadcn/ui, React Router. No Next.js: there is nothing to render server-side and it would add a container.

**Only backend dependency: `@aa/contracts`.** It cannot import `@aa/core` or `@aa/adapters`; `dependency-cruiser` forbids it (ADR-0010).

**UI copy is `es-AR`, formal register**, with Argentine number formatting (`$19.715.313,89`).

## 5. Screens

### 5.1 Dashboard — "where is my money?"

Period selector and a **waterfall**: gross Wompi sales → fees → VAT → withholdings → expected net → credited to bank → **difference**. Below it, three clickable counters — reconciled, ambiguous, unreconciled — each showing an amount as well as a count. What matters is not how many exceptions there are, but how much money they represent.

### 5.2 Exceptions inbox *(main screen)*

A work queue ranked by amount at risk. Each item: one sentence in Spanish, a status chip, the amount and the date. Filters by status, range and source. This is the screen that opens first.

### 5.3 Settlements

Table by day: date, gross, deductions (badged *explicit* versus *implied*), expected net, deposit, delta and confidence band. Expanding a row reveals the evidence list with pass/fail, expected versus observed, and the discarded alternatives with their reason.

### 5.4 Movement trace

The lineage `payment → batch → transfer → deposit` as a visual chain with amounts and IDs. Each link opens its detail; the last descends to the `RawRecord` with file, page and row.

### 5.5 ERP

Ledger and Odoo journal side by side, line by line, with the match level visible, a "discrepancies only" filter, and the **proposed correction** shown as a balanced double-entry table. The *Create missing entry* action is disabled with an explanatory note when `ODOO_WRITE_ENABLED=false`.

## 6. The evidence component

The heart of explainability in the UI, used identically in Phases 2 and 3.

It takes `Evidence[]` and a `code → phrase` table, and renders: a headline sentence, the list of checks with their result, and the score breakdown with each component's contribution. **The frontend never computes or writes conclusions**: it only translates codes to phrases. The same table feeds `report.md`.

## 7. States that must be designed

Not a detail: half the real experience.

| State | What to show |
|---|---|
| No data ingested | Which command to run or which file to upload |
| Run in progress | Progress per source |
| Stale source | Banner: "Odoo did not respond; this data is from DD/MM" |
| Parse rejected | Which file, which row broke the balance chain, what to do |
| Zero exceptions | Explicit confirmation that everything reconciled, with the amount |

## 8. Tests

| ID | Type | Verifies |
|---|---|---|
| F05-T01 | Component | The evidence component renders every code from `/evidence-codes` without hitting the "unknown code" fallback |
| F05-T02 | Component | The waterfall adds up: the last segment equals the difference the API reports |
| F05-T03 | Component | An ambiguous match shows its alternatives and presents none as chosen |
| F05-T04 | Component | The five states in §7 render without breaking |
| F05-T05 | Component | The Odoo write button is disabled and explained when the API reports it blocked |
| F05-T06 | Architecture | `apps/web` imports neither `@aa/core` nor `@aa/adapters` |
| F05-T07 | E2E (optional) | Path: dashboard → exception → evidence → trace → `RawRecord` |
| F05-T08 | Unit | Currency formatting is `es-AR` everywhere |

## 9. Definition of done

- [ ] All five screens work against the real API running in Docker.
- [ ] From any dashboard number, the originating `RawRecord` is at most three clicks away.
- [ ] No conclusion is shown without its evidence one click away.
- [ ] An ambiguous match is **never** presented as resolved.
- [ ] Empty and error states are designed, not blank pages.
- [ ] Works at laptop resolution with no horizontal scroll.

## 10. Open questions

- **Q5.1 — Should the CFO be able to confirm an ambiguous match manually?** That is what Xero does: the human decision is persisted and, optionally, becomes a rule. Real value, but it adds a new state model (who decided, when, why). Out of the base scope; proposed as a bonus.
- **Q5.2 — Excel export?** What a CFO always asks for. `movements.ndjson` plus a CSV covers 90% cheaply.
