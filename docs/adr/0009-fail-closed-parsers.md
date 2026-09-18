# ADR-0009 — Fail closed: a parse that breaks an invariant is rejected

**Status:** Accepted · **Date:** 2026-09-17

## Context

The primary source on the bank side is a PDF. PDFs change layout without warning, lose rows across page breaks, and extract text with subtle errors. A credulous parser produces an incomplete ledger that **looks correct**, and then the system reconciles over false data and reports invented discrepancies.

That is the worst possible failure mode: not a visible error, but a wrong conclusion presented with confidence.

## Decision

The parser validates invariants **before** handing back movements, and if one fails it throws `ParseIntegrityError` pointing at the exact row. It never returns partial results.

The Bancolombia statement hands us two invariants almost for free:

1. **Balance chain:** `balance[i] == balance[i−1] + value[i]`, starting from `SALDO ANTERIOR` and closing exactly on `SALDO ACTUAL`.
2. **Summary totals:** the sum of positive values equals `TOTAL ABONOS` and the sum of negatives equals `−TOTAL CARGOS`.

Together they detect a row lost across pages, a misread amount, an inverted sign and a layout change. And they cost nothing: the document already carries its own control figures.

The same principle applies to the other sources: the identity `payment − fee − VAT − withholding = net` plays that role for Wompi, and `Σdebits = Σcredits` for Odoo.

## Alternatives considered

- **Best effort with warnings.** Parse what you can, report the rest. Rejected: in an accounting system an incomplete ledger is worse than no ledger, because it generates false `MISSING_IN_ERP` results that send people chasing ghosts.
- **Validating after reconciliation.** Too late: the cost is already paid and the conclusions already emitted.
- **Trusting PDF text extraction.** Precisely what must not be done.

## Consequences

- A PDF with a new layout **fails loudly on day one**, instead of producing subtly wrong results for weeks.
- The error message must be actionable: which file, which row, what was expected and what was found. A fail-closed with a generic error is just an annoyance.
- There is a test that **deliberately mutilates a fixture** (deletes a row, alters one cent) and verifies the parse fails. That is the test proving the safeguard actually exists.
- If a legitimate statement failed over an unforeseen quirk, the system blocks. Accepted: preferable to reconciling over broken data, and the fix is to correct the parser, not to loosen the invariant.
