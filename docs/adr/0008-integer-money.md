# ADR-0008 — Integer money, Wompi truncation, largest-remainder allocation

**Status:** Accepted · **Date:** 2026-09-17

## Context

The whole system compares amounts and decides whether two things "are the same". A one-cent rounding error invalidates an entire reconciliation, and worse: it invalidates it intermittently.

Sources deliver money in different shapes: Wompi uses `amount_in_cents`, the bank statement uses pesos with two decimals and a comma thousands separator.

## Decision

**1. `Money` as a class with a private constructor**, holding an integer number of COP cents and validating the invariant. It is one of only two places in the domain where a class is used instead of a plain type, and the reason is to make an invalid amount impossible to construct.

**1b. Money knows integers and nothing else.** Three things that were briefly inside it do not belong there, and the reason is the same in each case: they are *edges*, not properties of an amount.

| Concern | Why it is not Money's | Where it lives |
|---|---|---|
| Reading `"393,279,689.19"` | Each source writes numbers its own way. A constant named `BANK_STATEMENT_FORMAT` in the domain means adding a source edits the domain | `adapters/shared/decimal-text.ts` |
| Rendering `"$19.715.313,89"` | A locale and a currency symbol are presentation decisions | `adapters/presentation/money-format.ts` |
| *Which* rounding to apply | Truncation is **Wompi's** policy. Baking it in means a gateway that rounds half-up forces a change to `Money` — an OCP violation | Caller passes a `Rounding` |

The symmetry is the point: text comes in through one adapter, text goes out through another, and the domain in between deals only in integers. A second locale or a new statement layout then costs nothing in `core`.

**1c. The integer algorithms live in `money-math.ts`.** `scaleInteger` and `allocateByLargestRemainder` are algorithms, not properties of a value, and they are worth testing directly. `Money` delegates to them in one line each, which keeps the value object at the size a value object should be.

**2. Normalise to cents at ingestion.** No later layer ever sees pesos or decimals. Formatting happens only at presentation, and the DTO carries a preformatted string alongside the cents so the frontend never reimplements it.

**3. Wompi truncates, it does not round.** 

**4. Largest-remainder allocation.** When attributing a batch's net to an individual payment, leftover cents go to the largest fractional parts. It is deterministic and guarantees that **the parts sum exactly to the whole** — a property test verifies it.

## Alternatives considered

- **Floating point.** Rejected without discussion.
- **`bigint`.** Unnecessary: COP amounts in cents fit comfortably in JavaScript's safe integer range, and `bigint` complicates serialisation and mixed arithmetic. If it ever becomes necessary, the change is encapsulated inside `Money`.
- **A decimal library (`decimal.js`, `dinero.js`).** Adds a dependency and a larger API than we need. Integers plus an 80-line class suffice.
- **Banker's rounding (half-even).** It would have been the default choice, but it **contradicts the observed data**. We chose to replicate reality, not convention.

## Consequences

- No rounding errors from floating-point arithmetic.
- Truncation has to be documented and tested explicitly, because it surprises anyone expecting rounding. That is test F01-T09.
- If amounts in another currency appeared, `Money` already carries `currency` and refuses to operate across currencies, but there is no conversion: that is out of scope.
