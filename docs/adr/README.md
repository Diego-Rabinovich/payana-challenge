# Architecture Decision Records

One decision per file. Format: context → decision → alternatives → consequences.

An ADR is not edited when we change our mind: it is marked **Superseded by** and a new one is written. The history of why we thought something is worth as much as the current decision.

| # | Decision | Status |
|---|---|---|
| [0001](0001-typescript-monorepo.md) | TypeScript and pnpm monorepo, over Java + Spring | Accepted |
| [0002](0002-canonical-model.md) | Single-entry canonical model; `Ledger` as projection; deterministic IDs | Accepted |
| [0003](0003-ingestion-transport-format.md) | Separate transport from format in ingestion | Accepted |
| [0004](0004-settlement-batch.md) | `SettlementBatch` as the join node; structure before combinatorics | Accepted |
| [0005](0005-deterministic-confidence.md) | Confidence as a deterministic rubric, no AI, no statistical model | Accepted |
| [0006](0006-erp-cascade-writeback.md) | ERP matching cascade and idempotent write-back | Accepted |
| [0007](0007-output-contract.md) | REST + OpenAPI + static artifacts; what was rejected | Accepted |
| [0008](0008-integer-money.md) | Integer money; Wompi truncation; largest-remainder allocation | Accepted |
| [0009](0009-fail-closed-parsers.md) | Fail closed: a parse that breaks an invariant is rejected | Accepted |
| [0010](0010-frontend-backend-boundary.md) | Front/back boundary: shared `contracts` package, not codegen | Accepted |
| [0011](0011-package-structure.md) | Three packages; `core` with a single dependency | Accepted |
| [0012](0012-live-credentials.md) | Live credentials: what we connect to and what we protect | Accepted |
