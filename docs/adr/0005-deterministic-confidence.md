# ADR-0005 — Confidence as a deterministic rubric, no AI, no statistical model

**Status:** Accepted · **Date:** 2026-09-17

## Context

The brief asks that, under ambiguity, the system state how confident it is or which alternatives it discarded, and that both a human and an AI be able to reconstruct the reasoning.

## Decision

The score is a **rubric of checks with fixed, versioned weights**, loaded from `config/ruleset.v1.json`. Each check emits an `Evidence` carrying its code, what was expected, what was observed and whether it passed.

**It is not a probability.** It is an auditable sum. The number never travels alone: it travels with its components.

Dimensions: amount (codes mutually exclusive), date (likewise), descriptor, uniqueness and integrity. Because the amount and date dimensions are mutually exclusive, **the score is normalised over the attainable maximum** (110), not over the sum of all weights; without that the bands mean nothing.

Bands: `≥85 CONFIRMED`, `60–84 PROBABLE`, `40–59 AMBIGUOUS`, `<40 UNMATCHED`. If the runner-up candidate sits within `ambiguityDelta` points, the result is **downgraded to `AMBIGUOUS`** regardless of how high the score is.

## Alternatives considered

- **Probabilistic scoring à la Fellegi–Sunter** (record linkage). It is the correct academic frame for this problem and was seriously considered. It requires calibrating weights on labelled data we do not have, and it produces a number the CFO cannot argue with. Rejected for auditability, not for inadequacy.
- **An LLM deciding matches.** Rejected: determinism *is* the product. A number that changes between runs cannot be taken to an audit. There is also no data volume to justify a model, and explainability would get **worse** — today every point of the score has a name.
- **A binary threshold with no score.** Simpler, but it loses the ability to express "almost certain" versus "doubtful", which is precisely what the brief asks for.

## Consequences

- **Verifiable reproducibility:** same inputs plus same `rulesetVersion` ⇒ same result, bit for bit. A test checks this.
- **Tunable without retraining anything:** changing a tolerance means editing JSON.
- The initial weights are a reasoned proposal, not a truth. They are calibrated against the first days of real data and the ruleset is versioned (`v1`, `v2`…), recording which one produced each result.
- Ambiguity **is reported**, never silently resolved by picking the best alternative. An ambiguous match presented as resolved would be the worst possible defect in an accounting system.
