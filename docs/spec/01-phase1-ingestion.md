# Spec 01 — Phase 1: Canonical model and ingestion

> Status: 🔨 In progress · Depends on: [00](00-foundations.md) · Enables: Phases 2 and 3

## 1. Objective

Turn heterogeneous sources — a bank PDF, a gateway API, a webhook — into one internal model of signed movements, without losing traceability back to the original byte.

## 2. Scope

**In:** the complete canonical model; the ingestion pipeline; the Bancolombia and Wompi adapters; the source registry; integrity validation; idempotency.

**Out:** reconciling anything. Phase 1 ends when two ledgers are loaded and verifiable. The Odoo adapter uses these same ports but is specified in [Phase 3](03-phase3-erp.md).

## 3. Inputs and outputs

| | |
|---|---|
| **Input** | Monthly Bancolombia PDFs (account 00000000000); Wompi transactions via API or panel export; recorded webhook payloads |
| **Output** | Populated `raw_records` and `movements` tables; one `IngestionReport` per run with counts, rejections and warnings |

## 4. Components to build

### 4.1 Domain (`packages/core/src/domain/`)

| Component | Form | Responsibility |
|---|---|---|
| `Money` | class | Integer COP cents. `ofCents`, `ofPesos`, `plus`, `minus`, `negate`, `abs`, `compareTo`, `allocate` (largest remainder), `format` |
| `MovementId`, `AccountId`, `RawRecordId`, `BatchId`, `RunId` | branded types | Cheap nominal typing: one cannot be passed where another is expected |
| `MovementType` | literal union | `CHARGE`, `FEE`, `TAX`, `WITHHOLDING`, `PAYOUT`, `DEPOSIT`, `REFUND`, `CHARGEBACK`, `INTEREST`, `BANK_FEE`, `BANK_TAX`, `TRANSFER_IN`, `TRANSFER_OUT`, `OTHER` |
| `Movement` | readonly type | The atomic unit. See §4.2 |
| `RawRecord` | readonly type | The raw fact, immutable, with `contentHash` |
| `SourceRef` | readonly type | The citation: `sourceId` + `rawRecordId` + `locator` |
| `Account` | readonly type | `GATEWAY` \| `BANK` \| `ERP` |
| `Ledger` | small class | Projection over movements: `balanceAt`, `between`, `byType`, `sum` |
| `errors.ts` | classes | `ParseIntegrityError`, `UnknownLayoutError`, `SourceUnavailableError` |

### 4.2 The central modelling decision

Each approved Wompi transaction produces **four movements**, not one, using exactly the four concepts that map onto the brief's chart of accounts:

| Wompi concept | Canonical type | Sign | Odoo account |
|---|---|---|---|
| Pago | `CHARGE` | + | 420500 Otras Ventas |
| Comisión | `FEE` | − | 530505 Gastos Bancarios |
| IVA de la comisión | `TAX` | − | 240810 IVA Descontable |
| Retención en la fuente | `WITHHOLDING` | − | 236500 Retención En La Fuente |

Decomposing at ingestion — rather than later — makes Phase 3 a direct mapping. All four share the `externalId` (the transaction reference), so they can always be regrouped.

**Where the deduction amounts come from is now an open problem.** Verified read-only against the live API on 2026-09-19: the transaction payload carries `amount_in_cents` and nothing else. `id`, `created_at`, `finalized_at`, `reference`, `customer_email`, `currency`, `payment_method_type`, `payment_method`, `status`, `status_message`, `shipping_address`, `redirect_url`, `payment_source_id`, `payment_link_id`, `customer_data`, `billing_data`, `origin` — no fee, no VAT, no withholding. The breakdown the merchant panel shows under *Entradas contables* is not exposed, and `/payouts`, `/settlements`, `/transfers` and `/balance` all return 404. See Q1.7.

**The invariant this enables:** the Wompi ledger balance returns to zero after each settlement (charges in, deductions and payout out). If it does not, a movement is missing.

### 4.3 Ports (`packages/core/src/ports/`)

| Port | Conceptual signature | Implementations in this phase |
|---|---|---|
| `SourceConnector` | `fetch(range) → AsyncIterable<RawRecord>` | `LocalFileConnector`, `HttpApiConnector`, `WebhookInboxConnector` |
| `RecordParser` | `canParse(raw) → boolean` plus `parse(raw) → CanonicalRecord[]` | Four parsers (§4.5) |
| `RawRecordRepository` | `upsert`, `findById`, `findBySource` | Postgres plus in-memory |
| `MovementRepository` | `upsertMany`, `findByAccount`, `findByExternalId` | Postgres plus in-memory |
| `Clock` | `now()` | Real plus fixed for tests |

There is no `IdGenerator` port: IDs are content hashes, which is a pure function.

### 4.4 Use case

`IngestSource(sourceId, range)` resolves connector and parser from `config/sources.json`, fetches `RawRecord`s, persists them, resolves the parser via `canParse()`, normalises, validates integrity, deduplicates by deterministic id, calls `upsertMany`, and returns an `IngestionReport`.

The pipeline is written **once**. Every new source is adapters, not changes here.

### 4.5 Adapters (`packages/adapters/src/`)

| Adapter | Transport | Format | Notes |
|---|---|---|---|
| `BancolombiaStatementParser` | local file | PDF | See §4.6 |
| `WompiTransactionsApiConnector` | HTTP | JSON | `GET /v1/transactions?from_date&until_date&page&page_size` (max 200), plus `?reference=` for a single lookup. Undocumented but verified working |
| `WompiTransactionParser` | — | JSON | One approved transaction → four movements |
| `WompiReportParser` | local file | CSV/XLSX | Panel export. Alternative path if the API falls short |
| `WompiEventParser` | webhook | JSON | `transaction.updated` plus SHA-256 checksum validation |
| `WompiSettlementParser` | SFTP or file | CSV | Settlement report → `PAYOUT` movements. **Conditional on Q1.3** |

> Do not change the panel's *Events URL*. It points at `api.prod.payana.cloud`, Payana's live integration. The webhook adapter is demonstrated with recorded payloads against a local endpoint.

### 4.6 The Bancolombia parser in detail

The highest-risk component, and the one that demonstrates the most engineering value.

**Header to extract:** account holder, account type and number, `DESDE`/`HASTA` period, and the `RESUMEN` block (previous balance, total credits, total debits, closing balance).

**Rows:** `FECHA` (`d/mm`, **no year**), `DESCRIPCIÓN`, `VALOR` (comma thousands, dot decimals, negatives signed), running `SALDO`.

**Year resolution:** taken from the header. If the row's month is lower than the month in `DESDE`, the year is the one in `HASTA`; otherwise the one in `DESDE`. The January statement starts on 31 Dec of the prior year, so this case is real, not hypothetical.

**Two integrity invariants; the parse fails if either breaks:**

1. **Balance chain:** `balance[i] == balance[i−1] + value[i]`, starting from `SALDO ANTERIOR` and closing exactly on `SALDO ACTUAL`.
2. **Summary totals:** positives sum to `TOTAL ABONOS`, negatives to `−TOTAL CARGOS`.

On failure, `ParseIntegrityError` names the row where the chain broke. **Fail closed:** the system never reconciles over badly read data, and it detects a layout change or a row lost across pages on its own.

**Descriptor classification** (from `config/descriptors.json`, not regexes in code):

| Pattern | Type | Role |
|---|---|---|
| `PAGO DE PROV WOMPI S.A.S.` | `DEPOSIT`, channel `wompi` | Phase 2 candidate |
| `ABONO INTERESES AHORROS` | `INTEREST` | Out of scope, never matched |
| `CUOTA MANEJO…` | `BANK_FEE` | Out of scope |
| `IVA CUOTA MANEJO…` | `BANK_TAX` | Out of scope |
| `PAGO INTERBANC <X>` | `TRANSFER_IN` | Another originator → reported as **unattributed** |
| no match | `OTHER` | Stays visible as unclassified. **Never hidden** |

Explicitly classifying what is *not* Wompi matters as much as matching: it prevents false positives and lets the system say "I saw this and chose not to touch it, for this reason".

### 4.7 Persistence

`raw_records` (id, source_id, origin, fetched_at, content_hash, payload, run_id) and `movements` (id, account_id, external_id, occurred_at, value_date, type, amount_cents, currency, counterparty, description, source_id, raw_record_id, locator, metadata jsonb, run_id).

Append-only. `upsert` by deterministic id: re-ingesting the same file duplicates nothing.

## 5. Settled decisions

1. **Deterministic `id`** = `sha256(sourceId | externalId | valueDate | cents | type)` truncated to 16 chars, prefixed `mov_`.
2. **Declined, voided and errored transactions produce no movements** — they moved no money, and a single-entry ledger records money. They stay in `raw_records` and the `IngestionReport` reports the count, so the absence is explainable.
3. **Truncation, not rounding.** Wompi truncates to two decimals: `7,862.40 × 19% = 1,493.856` displays as `1,493.85`; `317,549 × 1.5% = 4,763.235` displays as `4,763.23`. We replicate truncation and validate the identity `payment − fee − VAT − withholding = net` with a one-cent tolerance.
4. **Normalise to cents at ingestion.** The statement arrives in pesos with two decimals, the Wompi API in `amount_in_cents`. Internally everything is cents.
5. **`PAYOUT` is ingested if a settlement report exists**; otherwise Phase 2 builds the expectation and the movement is flagged as derived. See Q1.3.
6. **Transaction references are matched case-insensitively.** Odoo stores them uppercase (`TKFGJOKOQFHWVIGU71QQQ`), Wompi lowercase (`tkfgjokoqfhwvigu71qqq`).

## 6. Environment variables introduced

| Variable | Purpose |
|---|---|
| `SOURCE_MODE` | `fixtures` \| `live` |
| `DATA_DIR` | Fixture and output root |
| `WOMPI_BASE_URL`, `WOMPI_PRIVATE_KEY` | API connector |
| `WOMPI_EVENTS_SECRET` | Webhook checksum validation |
| `WOMPI_SFTP_*` | Settlement report (conditional on Q1.3) |
| `BANCOLOMBIA_ACCOUNT_NUMBER` | Bank account identity |
| `DATABASE_URL` | Persistence |

## 7. Tests

| ID | Type | Verifies |
|---|---|---|
| F01-T01 | Unit | `Money` rejects non-integers; `allocate` distributes cents by largest remainder and **the parts sum to the whole** |
| F01-T02 | Unit | Deterministic id is stable across runs and differs on any field change |
| F01-T03 | Parser | January statement: parses N rows, resolves the correct year, and the 31 Dec row lands in **2025** |
| F01-T04 | Parser | **Mutilated fixture**: a row is deleted → parse **fails** with `ParseIntegrityError` naming the row |
| F01-T05 | Parser | Fixture with one cent altered → fails on summary totals |
| F01-T06 | Parser | Descriptors: every pattern lands in its type; an unknown descriptor becomes `OTHER` and **appears** in the report |
| F01-T07 | Parser | One approved Wompi transaction yields exactly four movements summing to the net |
| F01-T08 | Parser | A declined transaction yields zero movements and increments the excluded counter |
| F01-T09 | Unit | Truncation reproduces real values: fee 7,862.40 → VAT 1,493.85 (not 1,493.86) |
| F01-T10 | Unit | Webhook checksum validates; a payload with an altered signature is rejected |
| F01-T11 | Integration | Ingesting the same file twice leaves the movement count unchanged (idempotency) |
| F01-T12 | Contract | `MovementRepository`: one suite passes against Postgres and in-memory |
| F01-T13 | Contract | `SourceConnector`: an empty range yields an empty iterable, does not throw |
| F01-T14 | Golden | Full fixture ingestion → movement snapshot; any change shows as a diff |
| F01-T15 | Unit | The Wompi ledger balance returns to zero after a complete settlement (when `PAYOUT` exists) |
| F01-T16 | Extensibility | A throwaway parser registers and works **without touching** `core` or the pipeline |

## 8. Definition of done

- [ ] All twelve Bancolombia statements parse with both invariants green.
- [ ] The Wompi ledger loads from API **or** panel export, with the four deductions per transaction.
- [ ] Every `Movement` has a `SourceRef` resolving to an existing `RawRecord`, with a `locator` that pinpoints the row or transaction.
- [ ] Re-ingesting everything twice changes no count.
- [ ] The `IngestionReport` reports: movements created by type, transactions excluded and why, unclassified descriptors, rejected files.
- [ ] F01-T16 demonstrates that adding a source does not touch `core`.
- [ ] `docs/ADDING-A-SOURCE.md` is written and reproducible by a third party.

## 9. How it is demonstrated

```
make ingest SOURCE=bancolombia FROM=2026-01-01 TO=2026-12-31
make ingest SOURCE=wompi       FROM=2026-01-01 TO=2026-12-31
```

Expected output: a per-source summary with movements by type, exclusions with reasons, and zero integrity errors. Then `aa ledger --account=bancolombia:00000000000 --month=2026-01` prints the ledger with a running balance that **closes against the statement**.

## 10. Open questions

- **Q1.1 — Which statement months actually exist in Notion?** The sample runs 31 Dec 2025 to 31 Jan 2026. Assuming twelve for 2026 until confirmed.
- **Q1.2 — Do all PDFs share one layout?** The design supports several via `canParse()`, but it has to be verified across all twelve.
- **Q1.3 — Does the panel or the SFTP expose the settlement report (the transfers to the bank)?** If so, `PAYOUT` is ingested and the zero-balance invariant applies. If not, Phase 2 derives it and flags it as derived.
- **Q1.7 — Where do the deduction amounts come from?** The API gives gross only. Three options: the panel export, the SFTP settlement report, or deriving the total from the gap between a day's gross and the bank credit and decomposing it by the observed rates. The third needs no new access and is verifiable — the decomposition has to reproduce the gap to the cent — but it changes Phase 2's evidence from *reported* to *derived*.
- **Q1.4 — Does the commission have a fixed component?** In the observed transaction, `7,862.40 / 317,549 = 2.476%`, an odd figure for a flat rate. It may be `X% + fixed`, or vary by card network. Determined by regression over ~50 transactions on day one; the result feeds Phase 2's `IMPLIED_FEE_IN_BAND` band.
- **Q1.5 — Are there refunds, voids or chargebacks in the period?** They would flip signs inside a batch.
- **Q1.6 — What is the data range?** The panel filter showed March–September 2026 and the sample statement is January. The challenge period needs pinning down.
