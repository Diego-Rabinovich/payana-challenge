# Spec 03 — Phase 3: Reconciliation against the ERP

> Status: 📝 Draft · Depends on: [01](01-phase1-ingestion.md) · Enables: [04](04-api-outputs.md)

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

## 4. What we know about the target journals

| | Journal 48 | Journal 49 |
|---|---|---|
| Name | Wompi Tarjetas | Bancolombia |
| Type | Bank | Bank |
| Bank account | `1110001 Wompi Tarjetas` | (to read) |
| Suspense account | `1010001 Wompi` | (to read) |
| Bank account number | `19300002179` | `00000000000` |
| Existing entries | 40, named `WMP/2026/00001`–`00040` | (to read) |
| Entry naming | Carries the Wompi reference: `WMP/2026/00001 (TKFGJOKOQFHWVIGU71QQQ)` | (to read) |
| Lines per entry | 2 | (to read) |

Two consequences:

**The suspense account is the bridge.** Money leaving the Wompi balance (`1110001`) and arriving at Bancolombia (`111001`) transits `1010001 Wompi`. There is no double-counting problem — there is a transit account.

**Two lines per entry means the breakdown is probably absent.** A complete entry needs five lines (bank, fee, VAT, withholding, sales). With two, the entry most likely records the gross amount against a single counterpart — leaving the bank overstated and fee, VAT credit and withholding unrecorded. This is a hypothesis drawn from a screenshot; it is **settled by reading the lines**, not by asking. Either way the design is identical: the parser reads whatever lines exist and maps them by account code.

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
**Bonus:** `PostMissingEntries` sends it to Odoo, dry-run by default, `--confirm` to execute, `ref = mov:<movementId>` as idempotency key, entries created as **draft**. Existing entries are never modified or deleted. See ADR-0006.

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
| `ODOO_WRITE_ENABLED` | `false`. Reads unrestricted; creating entries needs this plus `--confirm` |

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
