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

Ports are off the defaults on purpose — 5432, 3000 and 5173 are usually taken.
To change one, edit `infra/docker-compose.yml`.

Without credentials the system still runs: the four bank statements in
`data/fixtures/bancolombia` parse offline, and `SOURCE_MODE=fixtures` in `.env`
keeps Wompi and Odoo from being contacted at all.

### The batch pipeline

```bash
make demo                          # ingest → reconcile both phases → write the report
make run FROM=2026-01-01 TO=2026-04-30
make report                        # rewrite the artifacts from the last run
make down                          # stop everything
```

`make demo` prints a summary and writes `data/out/report.md` for a person and
`data/out/report.json` for a machine.

### For an AI client

The MCP server exposes the results as read-only tools over stdio. Configuration
and a worked session are in [docs/MCP.md](docs/MCP.md).

```bash
docker compose -f infra/docker-compose.yml --profile tools run --rm -T mcp
```

### Working on it

The test suite and the type checker run on the host and need pnpm:

```bash
corepack enable pnpm
pnpm install
make check      # boundaries, types, tests
```
