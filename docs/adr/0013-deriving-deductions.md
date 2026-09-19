# ADR-0013 — Deriving the gateway's deductions from the gap

**Status:** Accepted · **Date:** 2026-09-19

## Context

The reconciliation needs to know what Wompi kept from each settlement: commission, VAT on that commission, and withholding at source. The merchant panel shows all three under *Entradas contables*.

**The API does not.** Verified read-only against the live account: a transaction payload carries `id`, `created_at`, `finalized_at`, `amount_in_cents`, `reference`, `customer_email`, `currency`, `payment_method_type`, `payment_method`, `status`, `status_message`, `shipping_address`, `redirect_url`, `payment_source_id`, `payment_link_id`, `customer_data`, `billing_data` and `origin` — and nothing else, nested objects included. `/payouts`, `/settlements`, `/transfers`, `/balance` and `/reports` all return 404. The only amount available is the gross.

The listing endpoint does exist, though it is undocumented: `GET /v1/transactions` with `from_date`, `until_date`, `page` and `page_size` (max 200). A 422 on a bare call names the required parameters. So bulk ingestion is possible; the breakdown is not.

## Decision

Derive the deductions, and be explicit that they are derived.

**1. The total is observed, not estimated.** The gap between a day's gross and the credit that landed in the bank *is* the amount deducted. No model is involved in that step.

**2. The split uses two statutory rates and solves for the third unknown.**

```
withholding = 1.5%  of gross          (retención en la fuente on card sales)
VAT         = 19%   of the commission (IVA on the service)
commission  = whatever remains
```

Both percentages are set by Colombian law rather than by the gateway, so only the commission rate is unknown — and it does not need to be known, because it falls out of the subtraction.

**3. The check that means something.** The three parts reconstruct the gap *by construction*, so their summing proves nothing. What does prove something is recomputing VAT from the derived commission: if 19% of the derived commission equals the VAT the split produced, the numbers are consistent with the statutory rate and not merely with each other. That comparison is what `DEDUCTIONS_DERIVED` reports, with a tolerance that scales with the number of charges, since the gateway truncates each concept on each transaction.

**4. Anything the model cannot account for is reported, never forced.** A credit larger than the sales, or a gap too small to contain the withholding, yields no split at all. Manufacturing a negative commission to make the arithmetic close would hide exactly the discrepancy worth finding.

**5. A plausibility band, calibrated on real data.** Across four months of statements the total deduction clusters between 4.30% and 4.55%; the one transaction whose true breakdown is known sits at 4.446%. A gap outside that band splits arithmetically but is flagged, because something other than fees is explaining it.

## Validation

The derivation recovers the one transaction whose answer is known, to the cent, from nothing but the gross and the net:

| | Panel | Derived |
|---|---:|---:|
| Commission | 7,862.40 | **7,862.40** |
| VAT | 1,493.85 | **1,493.85** |
| Withholding | 4,763.23 | **4,763.23** |

## Alternatives considered

- **The panel export (CSV/XLSX).** Carries the real breakdown and remains the better source. Rejected as the primary path because it is a manual download: a system that cannot refresh itself is not a system. The parser stays in place for when the file is available, and the ingestion axes (ADR-0003) mean it plugs into the same pipeline.
- **The SFTP settlement report.** Probably carries it too, but no credentials were issued and it cannot be verified.
- **Assuming a fixed commission rate.** Simpler and wrong: the observed rate varies with card network, and a hardcoded 2.48% would silently misstate every settlement that used a different one.
- **Reporting only the total deduction, undecomposed.** Honest but useless downstream: Phase 3 needs three separate accounting lines, and the brief's chart of accounts asks for exactly those three.

## Consequences

- Evidence changes from *reported* to *derived*, and the report says so. `DEDUCTIONS_DERIVED` exists so a reader can tell the difference between a figure Wompi stated and one we computed.
- `basis: 'IMPLIED'` on the resulting `Deduction` carries the same signal into the data.
- If the panel export or the SFTP feed arrives later, the derived values become a cross-check on the reported ones — which is strictly better than having only one of the two.
- The 1.5% and 19% rates live in configuration, not in code: they are law today and law changes.
