# Conciliación — Alimentos Alcázar

Turns three sources into one explainable account of the money: Wompi's REST
API, Bancolombia's monthly PDF statements, and the Odoo journals that are the
formal system of record.

It answers one question, with the reasoning attached: **what did we expect to
receive, what reached the bank, what is missing, what is wrongly recorded in
the ERP, and why do we believe that.**

It runs in three phases:

| Phase | Question | Output |
|---|---|---|
| **1 · Ingestion** | Can every source be expressed in one model? | Two ledgers — Wompi and Bancolombia — of signed movements, each traceable back to the byte it came from |
| **2 · Channel → bank** | Did the money the gateway promised arrive? | One result per settlement, with its evidence, a confidence band and the candidates it discarded |
| **3 · Ledger → ERP** | Does the system of record reflect reality? | Line by line against journals 48 and 49, each discrepancy carrying the correction that would fix it |

---

## Running it

Everything runs in Docker. Nothing needs to be installed on the host.

```bash
cp .env.example .env     # fill in the Wompi and Odoo credentials
make up                  # db + api + web
```

| | |
|---|---|
| Console | <http://localhost:8090> |
| API docs | <http://localhost:3100/docs> |
| Postgres | `localhost:5433` |

The bank statements are not in the repository: upload them from the console
(**Nueva corrida**) or drop the PDFs in `data/statements/`. Without them every
settlement comes out unmatched, which is the correct answer.

### The batch pipeline

```bash
make demo                          # ingest → reconcile both phases → write the report
make run FROM=2026-01-01 TO=2026-04-30
make report                        # rewrite the artifacts from the last run
make down                          # stop everything
```

## Reading the output

`make demo` writes `data/out/report.md`, for the CFO; the console downloads the
same file. 

- **Wompi → Bancolombia**: the funnel (gross − deductions = expected vs
  credited) and how many settlements are `CONFIRMED` / `PROBABLE` /
  `UNMATCHED`. The deductions are derived: gross − credited.
- **versus the ERP**: per journal, entries that match, that are incomplete
  (lack the deduction lines) and that are missing.
- **Exceptions**: every settlement that is not `CONFIRMED`, with each evidence
  code as ✓/✗ and what was expected against what was observed.

`data/out/report.json` has everything, line by line: the API's DTOs for both
phases plus the rubric that gives each code its weight. The console shows the
same with the corrections each ERP line needs.

## How it is organized

```
packages/core       domain, rules, use cases, ports — no I/O
packages/adapters   Wompi, PDF parser, Odoo, Postgres; composition.ts wires it
packages/contracts  the Zod DTOs the API, web and MCP share
apps/api · web · cli · mcp   thin shells over the same use cases
config/             ruleset, chart of accounts, holidays, bank descriptors
docs/adr/           why each decision was made
```

Boundaries are enforced by `dependency-cruiser`, not by convention.

## For an AI client

The MCP server exposes the results as read-only tools over stdio. Configuration
and a worked session are in [docs/MCP.md](docs/MCP.md).

```bash
docker compose -f infra/docker-compose.yml --profile tools run --rm -T mcp
```

## Working on it

The test suite and the type checker run on the host and need pnpm:

```bash
corepack enable pnpm
pnpm install
make check      # boundaries, types, tests
```
