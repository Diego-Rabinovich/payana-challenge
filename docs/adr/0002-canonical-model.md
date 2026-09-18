# ADR-0002 — Canonical model: single entry, `Ledger` as projection, deterministic IDs

**Status:** Accepted · **Date:** 2026-09-17

## Context

We need to represent movements from heterogeneous accounts (payment gateway, bank, ERP) in one internal model that is simple to understand and cheap to extend.

## Decision

Five concepts and no more: `Money`, `Movement`, `RawRecord` + `SourceRef`, `Account` and `Ledger`.

**1. Single-entry accounting**, as the brief allows. Double entry appears **only** inside the Odoo adapter, when building the journal entry. Accounting complexity stays contained at one edge.

**2. `Ledger` is a projection, not a persisted entity.** We persist movements; the ledger is assembled by query. This avoids duplicated state and stale balances.

**3. Deterministic IDs** = `sha256(sourceId | externalId | valueDate | cents | type)`, truncated. Re-ingesting the same file does not duplicate: idempotency for free, and the ID is quotable inside an explanation.

**4. `RawRecord` kept separate from `Movement`.** The raw payload is stored before normalisation, with its `contentHash`.

> `RawRecord` is the **fact**. `Movement` is the **interpretation**. `SourceRef` is the arrow from interpretation back to fact.

That enables: re-parsing without re-fetching when a parser is fixed; detecting that a source changed; and every claim the system makes ending at an original byte, with file, page and row.

**5. The type taxonomy is defined by the brief's chart of accounts**, not by our imagination: `CHARGE`→420500, `FEE`→530505, `TAX`→240810, `WITHHOLDING`→236500, `PAYOUT`/`DEPOSIT`→111001. Wompi's real data confirmed it exposes exactly those four concepts per transaction.

**6. `metadata` as an escape hatch** for each source's idiosyncrasies. If a metadata field becomes necessary for a rule, only then is it promoted to a first-class field.

## Alternatives considered

- **Double entry in the domain.** Closer to real accounting, but the brief explicitly excludes it and it would double every movement without adding reconciliation power.
- **One `Movement` per Wompi transaction, with deductions as a sub-object.** More compact, but it breaks symmetry with the bank ledger and forces special cases in Phase 3. We chose to decompose into four movements sharing an `externalId`.
- **`Ledger` as a persisted aggregate with a materialised balance.** Faster to read, but introduces the classic desynchronisation problem.

## Consequences

- The Wompi ledger balance returns to zero after each settlement. We use this as an **integrity invariant**.
- Four movements per transaction multiplies row count. At this scale that is irrelevant.
- Any consumer can regroup by `externalId` when it needs the per-transaction view.
