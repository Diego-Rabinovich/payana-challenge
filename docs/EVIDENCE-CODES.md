# Evidence codes

A **closed** vocabulary. Every conclusion the system reaches is explained with these codes and no others.

Why closed: it lets an AI cite `IMPLIED_FEE_IN_BAND` and have it mean the same thing every time, instead of inventing categories. And it lets the frontend render Spanish without the backend generating prose.

**A code emitted by the engine but absent from this table breaks the build** (test F04-T07). That rule is the only thing keeping the vocabulary honest.

**Output locale:** `es-AR`, formal register. Code and documentation are in English; anything a human reads is in Spanish, with Argentine number formatting (`$19.715.313,89`).

## Shape of an `Evidence`

| Field | Meaning |
|---|---|
| `code` | One of the codes below |
| `dimension` | `AMOUNT` · `DATE` · `DESCRIPTOR` · `UNIQUENESS` · `INTEGRITY` · `ERP` |
| `passed` | Whether the check held |
| `weight` | Contribution to the score, from the ruleset |
| `expected` / `observed` | The compared values |
| `detail` | Optional context |

---

## Phase 2 — channel to bank

| Code | Dim. | Weight | Emitted when | Phrase (es-AR) |
|---|---|---:|---|---|
| `AMOUNT_EXACT` | AMOUNT | 50 | Observed net equals expected net | El monto acreditado coincide exactamente con el neto esperado. |
| `AMOUNT_WITHIN_ROUNDING` | AMOUNT | 40 | Difference within the rounding tolerance | El monto difiere en {delta}, dentro de la tolerancia de redondeo. |
| `IMPLIED_FEE_IN_BAND` | AMOUNT | 35 | No explicit deductions; the implied deduction falls in the plausible band | Las deducciones no vienen detalladas; la diferencia implica {rate} sobre el bruto, dentro del rango esperado. |
| `AMOUNT_MISMATCH` | AMOUNT | 0 | Difference exceeds every tolerance | El monto acreditado difiere en {delta} del neto esperado. |
| `DATE_T1_EXACT` | DATE | 25 | Credited on the next business day | Se acreditó el {fecha}, que es el día hábil siguiente a la venta. |
| `DATE_IN_WINDOW` | DATE | 15 | Within the window but not T+1 | Se acreditó {n} días hábiles después, dentro de la ventana esperada. |
| `DATE_OUT_OF_WINDOW` | DATE | 0 | Outside the window | La acreditación cae fuera de la ventana esperada. |
| `DESCRIPTOR_MATCH` | DESCRIPTOR | 15 | Bank descriptor matches the expected channel | El descriptor del extracto identifica a Wompi como originante. |
| `DESCRIPTOR_FOREIGN` | DESCRIPTOR | 0 | Descriptor belongs to a different originator | El descriptor corresponde a {origen}, no a Wompi. |
| `UNIQUE_CANDIDATE` | UNIQUENESS | 10 | No competitor nearby | No hay otro depósito que pueda corresponder a esta liquidación. |
| `COMPETING_CANDIDATE` | UNIQUENESS | 0 | A competitor within `ambiguityDelta` | Existe otro depósito igualmente compatible: {id}. |
| `IDENTITY_HOLDS` | INTEGRITY | 10 | `gross = net + fee + VAT + withholding` | El desglose cierra: el bruto menos las deducciones iguala al neto. |
| `IDENTITY_BROKEN` | INTEGRITY | 0 | The identity does not hold | El desglose no cierra por {delta}. |
| `SUBSET_SUM_UNIQUE` | AMOUNT | — | Fallback found exactly one combination | Se encontró una única combinación de pagos que suma el depósito. |
| `SUBSET_SUM_MULTIPLE` | AMOUNT | — | Fallback found several | Hay {n} combinaciones posibles; ninguna es concluyente. |
| `UNRESOLVED_COMBINATORIAL` | AMOUNT | — | Search budget exhausted | La búsqueda superó el límite configurado sin un resultado concluyente. |

**Score normalisation:** `AMOUNT` codes are mutually exclusive, and so are `DATE` codes. The attainable maximum is **110**, and the published score is `earned / attainable × 100`.

**Bands:** `≥85 CONFIRMED` · `60–84 PROBABLE` · `40–59 AMBIGUOUS` · `<40 UNMATCHED`.

**Downgrade rule:** `COMPETING_CANDIDATE` forces `AMBIGUOUS` regardless of score.

---

## Phase 3 — ledger to ERP

| Code | Level | Emitted when | Phrase (es-AR) |
|---|---|---|---|
| `MATCHED_BY_REF` | 1 | Entry carries the movement's idempotent `ref` | El asiento {erpId} referencia explícitamente al movimiento {movId}. |
| `MATCHED_EXACT` | 2 | Date, account and amount agree | Coinciden en fecha, cuenta y monto. |
| `MATCHED_AGGREGATED` | 3 | N daily movements sum to the entry | {n} movimientos del {fecha} suman el asiento {erpId}. |
| `INCOMPLETE_ENTRY` | 3 | Entry exists and the sale matches, but expected lines are missing | El asiento registra la venta pero no incluye {conceptos}. |
| `DATE_SHIFT` | 4 | Same amount, shifted date | Mismo monto, registrado {n} días hábiles después. |
| `AMOUNT_MISMATCH_ERP` | 5 | Same date and account, different amount | Misma fecha y cuenta, pero el monto difiere en {delta}. |
| `MISSING_IN_ERP` | 6 | Movement absent from Odoo | Este movimiento no tiene asiento en el diario {journal}. |
| `MISSING_IN_LEDGER` | 6 | Entry with no backing movement | El asiento {erpId} no corresponde a ningún movimiento ingestado. |
| `DUPLICATE_IN_ERP` | 7 | Two entries for the same thing | Hay {n} asientos que representan el mismo movimiento. |
| `NO_ACCOUNT_MAPPING` | — | Movement type has no account in the given chart | Este movimiento no tiene cuenta contable asignada en el plan del challenge. |

---

## Ingestion

| Code | Emitted when | Phrase (es-AR) |
|---|---|---|
| `BALANCE_CHAIN_OK` | Statement balance chain closes | El extracto es íntegro: la cadena de saldos cierra contra el saldo final. |
| `BALANCE_CHAIN_BROKEN` | It breaks at a row | La cadena de saldos se rompe en la fila {n}: se esperaba {expected} y se encontró {observed}. |
| `SUMMARY_TOTALS_OK` | Summary totals agree | Los totales de abonos y cargos coinciden con la suma de los movimientos. |
| `SUMMARY_TOTALS_MISMATCH` | They do not agree | Los totales del resumen no coinciden con la suma de las filas. |
| `TRANSACTION_EXCLUDED_NOT_APPROVED` | Transaction declined, voided or errored | Excluida del ledger: no movió dinero ({estado}). |
| `DESCRIPTOR_UNCLASSIFIED` | Descriptor matches no rule | Descriptor no reconocido; queda sin clasificar y visible. |
| `SOURCE_STALE` | Source unreachable, last snapshot used | Los datos de {fuente} son del {fecha}: la fuente no respondió. |
