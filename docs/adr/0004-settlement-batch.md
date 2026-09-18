# ADR-0004 — `SettlementBatch` as the join node: structure before combinatorics

**Status:** Accepted · **Date:** 2026-09-17

## Context

We need to relate N Wompi payments to M Bancolombia deposits. Amounts do not match by equality (fees and taxes intervene), there is a timing gap (T+1 business day), and there may be ambiguity (several subsets summing to the same figure).

The brief allows either a heuristic or an exact search, and warns there may be no single correct answer.

## Decision

Introduce `SettlementBatch` as a first-class entity: the set of charges for day D, with its deductions and its expected net.

With it, Phase 2 stops being an N-versus-M subset-sum problem and becomes a **1:1 match between a computed expectation and an observed deposit**.

> **The business structure (daily cutoff + T+1 business day) is the primary heuristic. Combinatorics is the fallback.**

Bounded subset-sum remains as a *fallback* for cases where the daily-batch hypothesis fails: partial deposit, batch split across two transfers, payment that fell out of the cutoff. When it fires it never yields `CONFIRMED` — arithmetic coincidence is weaker evidence than structural correspondence — and if it finds more than one solution, it lists them all as `AMBIGUOUS`.

## Alternatives considered

- **Subset-sum as the primary strategy.** Correct but expensive, and above all **badly explainable**: telling the CFO "these 47 payments add up to the deposit" is weaker than "the 31 Dec batch settled on 2 Jan, which is T+1 business days because 1 Jan was a holiday". The combinatorial blow-up with hundreds of daily payments is real, and ambiguity grows with set size.
- **Per-payment matching.** Impossible: Wompi nets and transfers once per day. There is no bank counterpart for a single payment.
- **A wide tolerance so things "close".** Rejected: it makes the problem disappear instead of reporting it.

## Consequences

- The default explanation is structural and readable by a human.
- The lineage of an individual payment is resolved by **allocating** the batch deductions (largest remainder), which is deterministic and sums exactly.
- If Wompi's cutoff were hourly rather than by calendar day, the hypothesis fails for late payments. That is detectable: a day that misses by exactly the amount of the last transactions. It stays as open question Q2.1, and the answer is implemented as a new rule in the ruleset, without touching the engine.
- `SettlementBatch` is also the natural object for building the Phase 3 journal entry.
