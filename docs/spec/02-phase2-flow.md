# Spec 02 — Phase 2: Flow reconciliation (channel to bank)

> Status: 🔨 Core implemented · Depends on: [01](01-phase1-ingestion.md) · Enables: [04](04-api-outputs.md)

## 1. Objective

Answer the operational question: **did the money Wompi promised actually reach the Bancolombia account?** And where it did not arrive as expected, explain exactly how it differs.

## 2. Scope

**In:** settlement batch construction, the Colombian business calendar, the rules engine, the confidence rubric, batch-to-deposit assignment, the combinatorial fallback, and lineage for an individual payment.

**Out:** the ERP. This phase does not know Odoo exists. The POS is out too.

## 3. Inputs and outputs

| | |
|---|---|
| **Input** | Wompi ledger (`CHARGE`/`FEE`/`TAX`/`WITHHOLDING`) and Bancolombia ledger (`DEPOSIT` classified as channel `wompi`) |
| **Output** | One `MatchResult` per batch, with status, amounts, evidence, confidence and discarded alternatives. Plus a list of **unattributed** bank deposits |

## 4. Components to build

### 4.1 Domain

| Component | Form | Responsibility |
|---|---|---|
| `SettlementBatch` | type plus pure functions | `batchDate`, `chargeIds`, `gross`, `deductions[]`, `expectedNet` |
| `Deduction` | type | `{ kind: FEE\|TAX\|WITHHOLDING, amount, basis: EXPLICIT\|IMPLIED }` |
| `Evidence` | type | `{ code, dimension, passed, weight, expected?, observed?, detail? }` |
| `EvidenceCode` | literal union | Closed vocabulary. See [EVIDENCE-CODES.md](../EVIDENCE-CODES.md) |
| `Confidence` | type | `{ score, band, components: Evidence[] }` |
| `MatchResult` | type | See §4.6 |
| `Lineage` | type | `Trace` output: payment → batch → transfer → deposit |

### 4.2 `BusinessCalendar` (port plus implementation)

`nextBusinessDay(date, n)`, `isBusinessDay(date)`, `businessDaysBetween(a, b)`.

Holidays come from `config/holidays-co.json`, with Ley Emiliani **already resolved in the data**: deterministic, testable and auditable, and about 40 lines of JSON instead of an algorithm full of edge cases.

Why it matters: in the sample statement the first Wompi deposit is **Friday 2 Jan**, with nothing on 1 Jan or over the weekend. The Wednesday 31 Dec sales credit on 2 Jan because 1 Jan is a holiday. Without a business calendar, that row does not match.

### 4.3 `BuildSettlementBatches` (use case)

Groups Wompi `CHARGE` movements by cutoff date and attaches each transaction's deductions. Because Wompi exposes fee, VAT and withholding per transaction, deductions are **explicit** and `expectedNet` is a sum, not an inference.

The **implied** deduction path (derived from the difference against the deposit) is implemented as a fallback and flagged `basis: IMPLIED` so the evidence says so.

### 4.4 Rules engine

| Component | Form | Responsibility |
|---|---|---|
| `MatchingRule` | interface | `evaluate(batch, candidates, ctx) → Candidate[]` |
| `T1DailyBatchRule` | class | Primary rule: batch for day D against deposits in `[D+1, D+3]` business days |
| `SubsetSumFallbackRule` | class | Bounded fallback (§4.7) |
| `RuleSet` | class | Loads rules, weights, tolerances and window from `config/ruleset.v1.json`. Exposes `version` |
| `ReconcileFlow` | class (use case) | Orchestrates: build batches → generate candidates → assign → score → persist |
| `BatchRepository` | port | **Not yet built.** Nowhere to store the batches a run produced |
| `MatchRepository` | port | **Not yet built.** Same for the results, so runs cannot be compared |

Adding a rule means adding a class and a ruleset entry. The engine does not change.

### 4.5 Confidence rubric

The score is **not a probability**: it is a sum of checks with fixed, versioned weights. Each check emits an `Evidence` carrying what was expected, what was observed and whether it passed. The number never travels alone.

| Dimension | Code | Weight |
|---|---|---:|
| Amount *(mutually exclusive)* | `AMOUNT_EXACT` | 50 |
| | `AMOUNT_WITHIN_ROUNDING` | 30 |
| | `IMPLIED_FEE_IN_BAND` | 25 |
| Date *(mutually exclusive)* | `DATE_T1_EXACT` | 25 |
| | `DATE_IN_WINDOW` | 15 |
| Descriptor | `DESCRIPTOR_MATCH` | 15 |
| Uniqueness | `UNIQUE_CANDIDATE` | 10 |
| Integrity | `IDENTITY_HOLDS` | 10 |

**Normalisation:** because the amount and date dimensions are mutually exclusive, the attainable maximum is **110**, not the sum of all weights. The published score is `earned / attainable × 100`, and the maximum is derived from the config so editing a weight cannot silently shift what a band means.

**Why the gap between exact and tolerable is wide.** `AMOUNT_WITHIN_ROUNDING` sits at 30 rather than 40 because with the narrower gap a $50 discrepancy still scored 91 and landed `CONFIRMED`. `CONFIRMED` has to mean "nobody needs to look at this"; a delta the system cannot explain deserves a glance however small it is. The weights were rebalanced after a test caught exactly that.

**Bands:** `≥85 CONFIRMED` · `60–84 PROBABLE` · `40–59 AMBIGUOUS` · `<40 UNMATCHED`.

**Downgrade rule:** if the runner-up candidate sits within `ambiguityDelta` (10 points) of the winner, the result drops to `AMBIGUOUS` regardless of score. Ambiguity is reported, never silently resolved.

### 4.6 Batch-to-deposit assignment

Not a naive 1:1 by date. The procedure:

1. Generate every `(batch, deposit)` pair inside the window whose score clears a floor.
2. Sort descending by score.
3. Take greedily, marking both sides consumed.
4. Record, for each pair taken, the best rejected candidate and **why** it lost.
5. Whatever is left unpaired goes to the fallback.

This covers the real cases: two Wompi deposits on the same day, a day with no deposit followed by a double one, and two batches competing for the same deposit.

`MatchResult` carries: `left` (batchId plus chargeIds), `right` (deposit movementId), `rule` (id plus version), `amounts` (gross, deductions, expected net, observed net, delta, implied rate), `window` (from, to, business-day basis), `confidence` (score, band, components) and `alternatives` (candidate, score, rejection code). Field for field, that is the brief's explainability checklist.

### 4.7 Fallback: bounded subset-sum

Fires when the daily-batch hypothesis fails: partial deposit, batch split across two transfers, a payment that fell out of the cutoff.

DP over amounts in cents, with tolerance, a subset-size cap and a solution cap, all from the ruleset. Exit rules:

- **One** solution → `PROBABLE` (never `CONFIRMED`: arithmetic coincidence is weaker than structural correspondence).
- **More than one** → `AMBIGUOUS` with **every** alternative listed. None is silently chosen.
- Cap exceeded → `UNRESOLVED_COMBINATORIAL`, which is also an honest answer.

### 4.8 `TraceMovement`

For an individual `CHARGE`: `charge → batch → expectedNet → deposit`, with the **attributed net** allocating the batch's deductions by largest remainder. This answers the brief's literal question: the funds of this $100 payment, net of fees, ended up inside that deposit.

### 4.9 Unattributed deposits

Every bank credit that ended up unassigned appears in a separate list with its classification: `INTEREST`, `TRANSFER_IN`, `OTHER`. Not a system error: information the CFO needs.

## 5. Settled decisions

1. **Business structure is the primary heuristic; combinatorics is the fallback.** `SettlementBatch` turns the problem into a 1:1 match between expectation and observation.
2. **Deterministic rubric confidence, no AI and no statistical model.** Reproducible bit for bit given `(inputs, rulesetVersion)`, auditable point by point, tunable without retraining. See ADR-0005.
3. **Every threshold is configuration**, not a constant: window, tolerances, weights, bands, `ambiguityDelta`, subset-sum caps.
4. **`rulesetVersion` travels in every `MatchResult`.** Without it a result is not reproducible.
5. **Non-Wompi deposits are classified explicitly**, not ignored.

## 6. Configuration and environment

| Key | Where | Purpose |
|---|---|---|
| `RULESET_PATH` | env | Which ruleset to use |
| `settlementWindow.{from,to}` | ruleset | Business-day window, default `[D+1, D+3]` |
| `tolerances.roundingCents` | ruleset | Default 10,000 cents ($100) |
| `tolerances.impliedFeeRateBand` | ruleset | Default `[0.02, 0.05]`. Calibrated via Q1.4 |
| `weights.*`, `bands.*`, `ambiguityDelta` | ruleset | The rubric |
| `subsetSum.{maxSubsetSize,maxSolutions,toleranceCents}` | ruleset | Fallback caps |
| `TZ=America/Bogota` | env | Business date |

## 7. Tests

| ID | Type | Verifies |
|---|---|---|
| F02-T01 | Unit | `nextBusinessDay(2025-12-31)` = `2026-01-02` (1 Jan holiday). The real case from the statement |
| F02-T02 | Unit | Weekends: Friday → Monday; and a holiday moved by Ley Emiliani |
| F02-T03 | Unit | The batch groups approved transactions only, and `expectedNet = Σpayments − Σdeductions` |
| F02-T04 | Unit | Perfect match → `AMOUNT_EXACT` plus `DATE_T1_EXACT` → score 100 → `CONFIRMED` |
| F02-T05 | Unit | Normalisation works: a match on `IMPLIED_FEE_IN_BAND` plus `DATE_IN_WINDOW` yields a coherent score, not a meaningless percentage |
| F02-T06 | Unit | A $50 difference → `AMOUNT_WITHIN_ROUNDING`, band `PROBABLE` |
| F02-T07 | Unit | Two identically sized deposits in the window → `AMBIGUOUS` with **both** in `alternatives` |
| F02-T08 | Unit | Downgrade: a runner-up 6 points behind drops the result to `AMBIGUOUS` even at score 92 |
| F02-T09 | Unit | A day with no sales creates no batch; a day with sales and no deposit → `UNMATCHED` with a reason |
| F02-T10 | Unit | Two Wompi deposits on one day → assignment does not give both to the same batch |
| F02-T11 | Unit | Subset-sum with two solutions → `AMBIGUOUS`; with one → `PROBABLE`, never `CONFIRMED` |
| F02-T12 | Unit | Subset-sum exceeding the cap → `UNRESOLVED_COMBINATORIAL`, without hanging |
| F02-T13 | Unit | `Trace` of a payment: attributed nets sum exactly to the batch net, with no cents lost |
| F02-T14 | Unit | A `PAGO INTERBANC` deposit is never assigned to a Wompi batch |
| F02-T15 | Unit | Every `MatchResult` carries `rulesetVersion` and at least one `Evidence` per evaluated dimension |
| F02-T16 | Property | For any batch, `Σ(attributed nets) == expectedNet` |
| F02-T17 | Reproducibility | Two runs over the same inputs produce identical `MatchResult`s |
| F02-T18 | Golden | Full reconciliation over fixtures → reviewable snapshot |
| F02-T19 | Extensibility | Adding a `T2BatchRule` to the ruleset activates it **without touching** `ReconcileFlow` |

## 8. Definition of done

- [ ] Every Wompi deposit in the period ends in one of: `CONFIRMED`, `PROBABLE`, `AMBIGUOUS`, `UNMATCHED` or `UNRESOLVED_COMBINATORIAL`. **None unclassified.**
- [ ] Every `MatchResult` explains: which movements it relates, which rule it used, which amount adjustment it applied, which window it considered, how confident it is, and what it discarded.
- [ ] Every unattributed bank deposit is listed with its classification.
- [ ] No threshold is hardcoded: changing a tolerance means editing JSON.
- [ ] F02-T17 passes: the system is reproducible.
- [ ] `Trace` over any `CHARGE` returns the full chain with IDs resolvable down to the `RawRecord`.
- [ ] Every evidence code used is documented in `EVIDENCE-CODES.md`.

## 9. How it is demonstrated

```
make reconcile FROM=2026-01-01 TO=2026-12-31
```

Expected output: a summary by status, total reconciled versus unreconciled, and for any given day the detail with its evidence. For 31 Dec 2025 → 2 Jan 2026 in the sample statement, the result must be `CONFIRMED` with `DATE_T1_EXACT` thanks to the holiday.

## 10. Open questions

- **Q2.1 — Is the Wompi cutoff by calendar day or by hour?** Assuming calendar day in `America/Bogota`. With an hourly cutoff, late payments fall into the next batch. **Verifiable from the data:** if a day misses by exactly the amount of its last transactions, the hourly cutoff is the explanation.
- **Q2.2 — Can Wompi transfer twice for one batch?** The assignment supports it, but it changes which state counts as normal and which as exception.
- **Q2.3 — What tolerance does the business accept?** The $100 is a proposal. The CFO may want zero.
- **Q2.4 — Are withholdings applied per transaction or per settlement?** In the observed transaction they appear per transaction (1.5%), but that should be confirmed against the transfer total.
- **Q2.5 — Depends on Q1.4:** the implied-fee band can only be calibrated once we know whether the rate has a fixed component.
