# Spec 03 — Phase 3: Reconciliation against the ERP

> Status: 🔨 Core implemented · Depends on: [01](01-phase1-ingestion.md) · Enables: [04](04-api-outputs.md)

## 1. Objective

Answer the accounting question, distinct from Phase 2's: **does the system of record reflect what actually happened?** Compare each ledger against its formal book in Odoo, line by line, with matches and discrepancies explained.

## 2. Scope

**In:** reading journals 48 (Wompi Tarjetas) and 49 (Bancolombia); normalising entries into the canonical model; the matching cascade; the line-by-line report; and a `proposedEntry` per discrepancy.

**Out:** inferring which channel the money came from — Phase 2 already answered that. Phase 2's results are used only to build the proposed entry.

## 3. Inputs and outputs

| | |
|---|---|
| **Input** | Phase 1 canonical ledgers plus Odoo entries from journals 48 and 49 |
| **Output** | One `ErpReconciliationLine` per element on both sides, with status, match level, evidence and a proposed correction |

## 4. The target journals, read

Verified read-only against `payana-prod` on 2026-09-19.

| | Journal 48 | Journal 49 |
|---|---|---|
| Name / code | Wompi Tarjetas · `WMP` | Bancolombia · `BNK8` |
| Type | Bank | Bank |
| Default account | `1110001 Wompi Tarjetas` | `111001 Bank` |
| Suspense account | `1010001 Wompi` | `111002 Bank Suspense Account` |
| Entries | 40, `2026-01-03` → `2026-04-24` | 12, `2026-01-02` → `2026-06-11` |
| Reference | `ref` holds the gateway reference, uppercase | `ref` is the label `Acreditación Wompi` |
| Lines per entry | **2, every one of them** | 2 |

**The reference lives in `ref`,** not in the entry name — uppercase in Odoo, lowercase in Wompi, so matching is case-insensitive.

**Every entry in journal 48 is incomplete.** Across all forty, only two account codes appear at all:

```
Debit   1110001 Wompi Tarjetas   = GROSS
Credit  420500 Other sales       = GROSS
```

No `530505` fee, no `240810` VAT, no `236500` withholding — anywhere. The gross is booked as if it had all landed, so the gateway balance is overstated by every deduction ever charged.

**Journal 49 is the bridge, and it is barely used.** Its twelve entries debit `111001 Bank` and credit `1110001 Wompi Tarjetas`: the settlement moving money out of the gateway balance into the bank. Amounts tie exactly to the statement — `19,715,313.89` on 2026-01-02 is the first Wompi credit of the year.

**What already reconciles, measured.** Every one of the forty entries resolves to a real approved transaction by reference, and every one carries the correct gross:

| | |
|---|---:|
| Approved Wompi transactions, Jan–Apr 2026 | 115 |
| Entries in journal 48 | 40 |
| **Entries whose `ref` resolves to an approved transaction** | **40 / 40** |
| **Entries whose gross matches that transaction to the cent** | **40 / 40** |
| Approved transactions with no entry at all | 75 |

So the finding is not "the ERP is wrong". It is precise: *what was recorded, was recorded correctly; it is missing the deduction lines, and three quarters of the transactions were never recorded at all.* Reference matching resolves the first forty with no ambiguity whatsoever — level 1 of the cascade does the work, exactly as designed.

The bank side is the same shape: the statements contain 58 Wompi credits over the four months, and journal 49 holds 12.

**The number that summarises the gap:**

```
journal 48 → debits to 1110001    $ 92.933.959,00
journal 49 → credits to 1110001   $ 50.832.937,61
                                  ───────────────
balance stranded on 1110001       $ 42.101.021,39
```

That account should drain towards zero as settlements arrive. It does not, for two compounding reasons: deductions are never booked, and only twelve of the settlements were recorded at all. That figure is what Phase 3 has to explain, line by line.

## 5. Components to build

| Component | Responsibility |
|---|---|
| `OdooRpcClient` | Transport: `api_key` as password, `execute_kw`, company context |
| `OdooJournalConnector` | `SourceConnector`: fetches `account.move` plus `account.move.line` for a journal and range |
| `OdooMoveParser` | `RecordParser`: entry → canonical movements |
| `FixtureErpGateway` | Same interface reading from `data/fixtures/odoo/` |
| `ErpGateway` | Port: `readJournal(journalId, range)` and `postEntry(draft)` |
| `ReconcileErp` | Use case: the cascade of §6 |
| `ProposedEntry` | The correction as data: accounts, debits, credits, `ref` |
| `PostMissingEntries` | **Bonus.** Sends `ProposedEntry` to Odoo. Dry-run by default |

**Double-entry to single-entry translation:** on lines for the relevant account, `debit > 0` is an inflow (+) and `credit > 0` an outflow (−). The internal model stays single-entry; double entry lives **only** inside this adapter.

## 6. Matching cascade

The real difficulty is **granularity**: our ledger has one movement per payment, Odoo has whatever it has. A naive 1:1 comparator would report that everything is wrong.

Every reported line declares which level resolved it:

| Level | Criterion | Resulting status |
|---|---|---|
| 1 | Idempotent `ref`, or the Wompi reference embedded in the entry name | `MATCHED_BY_REF` |
| 2 | Natural key: `(date, account, amount)` | `MATCHED_EXACT` |
| 3 | N:1 aggregation: daily ledger sum versus daily entry | `MATCHED_AGGREGATED` |
| 3b | The sale matches but expected lines are missing | `INCOMPLETE_ENTRY` |
| 4 | Same amount, date shifted ≤2 business days | `DATE_SHIFT` |
| 5 | Same date and account, different amount | `AMOUNT_MISMATCH_ERP` |
| 6 | No counterpart | `MISSING_IN_ERP` \| `MISSING_IN_LEDGER` |
| 7 | Two ERP entries for the same thing | `DUPLICATE_IN_ERP` |

Level 1 is handed to us by the data: the entry name carries the Wompi reference. Matching is a case-insensitive comparison — Odoo stores it uppercase, Wompi lowercase.

Each line carries `ledgerMovementIds[]`, `erpMoveId`, `erpLineId`, `delta`, `matchLevel`, `Evidence[]` and `proposedEntry`. Same evidence structure as Phase 2: one explanation vocabulary for the whole system.

## 7. Correction as data

To report *"this entry is missing its fee, VAT and withholding lines"*, the system must already know which lines should exist. That object is built either way, so every discrepancy carries a `proposedEntry`:

| Account | Debit | Credit |
|---|---|---|
| 111001 Banco (transferred net) | net | |
| 530505 Gastos Bancarios | fee | |
| 240810 IVA Descontable | VAT | |
| 236500 Retención En La Fuente | withholding | |
| 420500 Otras Ventas | | **gross** |

It balances by the identity `gross = net + fee + VAT + withholding` — the same one Phase 2 validates.

**Required:** the reconciliation prints this in `report.md` and emits it structured in `report.json`.
**Bonus:** `PostMissingEntries` sends it to Odoo, off unless `ODOO_WRITE_ENABLED`, one entry per button press in the console, `ref = mov:<movementId>` as idempotency key, entries created as **draft**. Existing entries are never modified: what they lack is shown read-only. See ADR-0006.

## 8. Settled decisions

1. **The ERP enters through the same ports as any other source.** No special path.
2. **Double entry is contained in the adapter.** The domain does not know about it.
3. **The cascade is explicit and the match level is reported.** "They match" is not enough: we say by which criterion.
4. **The correction is data.** Printing it or POSTing it is a delivery decision, not a design one.
5. **Which account the existing entries use is determined empirically**, by reading them — not by guessing between `1110001` and `111001`.
6. **Nothing existing is modified or deleted.** Discrepancies are reported; correcting is a human decision.

## 9. Environment variables

| Variable | Notes |
|---|---|
| `ODOO_URL` | `https://payana-prod.odoo.com` |
| `ODOO_DB` | **Missing.** No authentication without it (Q3.1) |
| `ODOO_USER_ID` | `10` |
| `ODOO_API_KEY` | Replaces the password in XML-RPC/JSON-RPC |
| `ODOO_COMPANY_ID` | `2`, goes in the context |
| `ODOO_JOURNAL_WOMPI` | `48` |
| `ODOO_JOURNAL_BANCOLOMBIA` | `49` |
| `ODOO_WRITE_ENABLED` | `false`. Reads unrestricted; creating entries needs this, and only drafts in journals 48/49 |

The canonical-type → account-code map lives in `config/odoo-accounts.json`, not in env and not in code.

## 10. Tests

| ID | Type | Verifies |
|---|---|---|
| F03-T01 | Unit | An Odoo debit line becomes a positive movement; a credit line, negative |
| F03-T02 | Unit | Cascade level 1: an entry whose name carries a known Wompi reference matches, case-insensitively, and stops descending |
| F03-T03 | Unit | Cascade level 3: five ledger movements against one daily entry → `MATCHED_AGGREGATED` with all five IDs listed |
| F03-T04 | Unit | A two-line entry whose sale matches but lacks fee/VAT/withholding → `INCOMPLETE_ENTRY` naming the missing concepts |
| F03-T05 | Unit | A movement with no counterpart → `MISSING_IN_ERP` with amount and date |
| F03-T06 | Unit | An entry with no backing → `MISSING_IN_LEDGER` |
| F03-T07 | Unit | Same amount two business days apart → `DATE_SHIFT`, not `MISSING` |
| F03-T08 | Unit | Two identical Odoo entries → `DUPLICATE_IN_ERP` |
| F03-T09 | Unit | The `proposedEntry` **balances**: Σdebits = Σcredits |
| F03-T10 | Unit | The `proposedEntry` uses the five account codes from `odoo-accounts.json` |
| F03-T11 | Unit | With `ODOO_WRITE_ENABLED=false`, `postEntry` is **never** invoked; the plan is produced |
| F03-T12 | Unit | Idempotency: an existing `ref` does not create a second entry |
| F03-T13 | Contract | `ErpGateway`: one suite passes against `OdooRpcGateway` (recorded responses) and `FixtureErpGateway` |
| F03-T14 | Integration | Odoo unreachable → `SourceUnavailableError`, the report still emits marking the source stale, the system does not crash |
| F03-T15 | Golden | Full ERP reconciliation over fixtures → line-by-line snapshot |
| F03-T16 | Unit | Every report line has a `matchLevel` and at least one `Evidence` |

## 11. Definition of done

- [ ] Both journals are read and normalised into canonical movements.
- [ ] **Every** line on both sides appears in the report with a status. None is lost in between.
- [ ] Each match shows the ledger ID and the entry ID, making clear they represent the same thing — the brief's literal requirement.
- [ ] Each discrepancy states what is missing, on which side, and where inferable, why.
- [ ] Every discrepancy carries a `proposedEntry` that balances and uses the brief's accounts.
- [ ] With the guards on, writing to Odoo by accident is impossible.
- [ ] The system still delivers a useful report when Odoo is unreachable.

## 12. How it is demonstrated

```
aa reconcile-erp --journal=48 --from=2026-01-01 --to=2026-12-31
aa post-missing  --journal=48 --dry-run          # prints the plan, writes nothing
```

Expected output: counts by status, and line-by-line detail with IDs from both sides.

## 13. Open questions

- **Q3.1 — `ODOO_DB` and `ODOO_API_KEY` are missing.** Blocking for `live` mode. Fixtures let work continue.
- **Q3.2 — Do the two lines of the existing entries record gross without breakdown?** Resolved by reading, not by asking. It determines which finding dominates the report.
- **Q3.3 — Does journal 48's bank line use `1110001` or `111001`?** The journal declares `1110001 Wompi Tarjetas`; the brief's list says `Banco → 111001 Banco`. Determined by reading the 40 existing entries.
- **Q3.4 — Should Phase 3 write, or only reconcile?** The brief asks for `Conciliar()`; the access notes read as instructional. Resolved by producing the correction as data and putting execution behind a flag. Confirmation requested from the challenge author.
- **Q3.5 — What about interest, account maintenance fees, their VAT and the statement's retefuente?** The given chart does not cover them. Assumption: they enter the Bancolombia ledger — otherwise the balance would not close — and are flagged `NO_ACCOUNT_MAPPING` without inventing accounts.
