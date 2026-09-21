# ADR-0006 — ERP matching cascade, and correction as data

**Status:** Accepted · **Date:** 2026-09-17

## Context

Phase 3 compares each ledger against its formal book in Odoo. Two things make it harder than it looks.

**First, the granularities differ.** Our ledger holds one movement per payment; Odoo holds whatever it holds. A naive 1:1 comparator would report that everything is wrong — noise that buries the real discrepancies.

**Second, the brief is genuinely ambiguous about whether we should write.**

- Phase 3 asks for a primitive that **reconciles** — `Conciliar(Ledger, LibroContable)` — and deliverable 5 is "matches and discrepancies, line by line". That is read-only.
- The access notes say movements "**must end up recorded**" in journals 48 and 49, that "records **are created** as journal entries", and list the accounts "**to be used**". Journal 48 is a Bank-type journal with a suspense account configured and bank feeds set to "Manual (or import CAMT, CSV, OFX, PDF, XLS…)" — a journal set up for data to be loaded into it.

Both readings are defensible.

## Decision

**1. An explicit five-level cascade**, with every reported line declaring which level resolved it: idempotent `ref` → 1:1 by natural key → N:1 by daily aggregation → approximate (`DATE_SHIFT`, `AMOUNT_MISMATCH`) → unmatched (`MISSING_IN_ERP`, `MISSING_IN_LEDGER`, `DUPLICATE_IN_ERP`).

Saying *"they match"* is not enough: we say **by which criterion**, because an aggregated match is weaker evidence than a match by reference.

Level 1 is handed to us by the data: entries are named `WMP/2026/00001 (TKFGJOKOQFHWVIGU71QQQ)`, carrying the Wompi transaction reference. Matching is a case-insensitive comparison — Odoo stores it uppercase, Wompi lowercase.

**2. The ERP enters through the same ports as any other source.** An accounting book is a `Ledger` with `kind: 'ERP'`. That uniformity keeps this phase short.

**3. Resolve the write ambiguity by making it a delivery decision, not a design one.**

To report *"this entry is missing its fee, VAT and withholding lines"*, the system must already know exactly which lines should exist, against which account, for which amount. That object exists either way. So every discrepancy carries a **`proposedEntry`**: accounts, debits, credits and `ref`.

- **Required deliverable:** the reconciliation prints `proposedEntry` in `report.md` and emits it structured in `report.json`.
- **Optional:** `PostMissingEntries` takes those same objects and calls `create`. Off unless `ODOO_WRITE_ENABLED`, one entry per button press in the console, `ref = mov:<movementId>` as idempotency key (Stripe's pattern), entries created as **draft**.

**4. Existing entries are never modified or deleted.** Discrepancies are reported. Correcting is a human decision.

## What the journal configuration resolved

Two questions that looked like they needed asking turned out to be answerable by reading:

- **The suspense account is the bridge.** Journal 48 has `Transitory account: 1010001 Wompi` configured. Money leaving the Wompi balance and arriving at Bancolombia passes through it. There is no double counting problem — there is a transit account we had not noticed.
- **The bank account code is determined empirically.** Journal 48 declares `Bank account: 1110001 Wompi Tarjetas`, while the brief's list says `Banco → 111001 Banco`. Rather than guessing, we read which account the 40 existing entries actually use. It is an observable fact, not a judgement call.

## Alternatives considered

- **Report only, with no proposed correction.** Cheaper, but it throws away information the system already computed, and leaves the "must end up recorded" reading unaddressed.
- **Write by default.** Rejected: creating entries in a production ERP should be a deliberate act, and the brief does not require it.
- **1:1 matching only.** Simpler, fails in the most likely scenario.
- **Normalising both sides to a common grain before comparing.** Loses which ledger movement corresponds to which entry line — exactly what the brief asks us to show.
- **Posting entries automatically.** Creating a draft is reversible; posting is much less so.

## Consequences

- Double entry stays **contained inside the Odoo adapter**. The domain does not know about it.
- The proposed entry balances by the identity `gross = net + fee + VAT + withholding`, the same one Phase 2 validates. A test verifies it.
- The cascade has more code than a simple match, but each level is trivial and independently testable.
- Phase 3 produces three distinct kinds of finding rather than one: entries that exist but are incomplete, entries whose bank line is overstated, and transactions with no entry at all.
