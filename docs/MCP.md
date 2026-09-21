# The MCP server

*Written for: whoever connects an AI client to this system, and anyone judging
whether the bonus was worth building.*

The brief names two users. The console serves the CFO. This serves the other
one — an accountant that is a model, which needs to consume the results
programmatically and reason over them.

## Why it exists

Without it, handing a period of ledgers to a model means pasting
`report.json` into a prompt. For four months that file is already a megabyte;
for a year of a chain it is not going to fit, and if it did the model would be
reasoning over noise to answer a question about one settlement.

MCP turns that into a conversation. The agent asks for the summary, sees that
3 settlements did not match, pulls one, and asks why. It reads a few kilobytes
instead of a megabyte, and each answer is the same object the API would have
returned.

## Three rules, and they are the design

**No tool computes anything.** Every one reads a result the deterministic core
already produced. A model is never in the path where an amount is decided —
a CFO cannot take a number that changes between runs to an audit.

**Tools return the same DTOs as the HTTP API.** The Zod schemas in
`@aa/contracts` are reused as-is, so there is no second set to keep in step.

**There are no write tools.** `create_entry` is not exposed and will not be.
Creating entries in a production ERP does not belong one prompt away; that
stays in the console, behind a button a person pressed. A test asserts no
tool name matches `create|post|update|delete|write|approve`.

## Tools

| Tool | Returns |
|---|---|
| `get_run_summary` | The funnel: gross → deductions → expected → credited → difference |
| `list_exceptions` | The work queue, filtered by band, paginated |
| `explain_match` | Every check, its weight, the band, the window, the discarded candidates |
| `trace_movement` | A payment's lineage down to the raw record and its locator |
| `find_movement` | One movement by id |
| `list_unattributed_credits` | Credits no settlement claimed |
| `get_erp_discrepancies` | Phase 3 for one journal, with the correction each line implies |
| `get_evidence_codes` | The closed vocabulary, so an agent cites codes instead of inventing categories |

That last one matters more than it looks. A model asked to summarise findings
will coin its own taxonomy, and two summaries then cannot be compared. Handing
it the vocabulary is what keeps the language stable across runs.

## Connecting a client

The server speaks stdio, which is how an MCP client starts one: it spawns the
process and talks over the pipe. Add this to your client's configuration —
`claude_desktop_config.json` for Claude Desktop, `.mcp.json` for Claude Code:

```json
{
  "mcpServers": {
    "conciliacion": {
      "command": "docker",
      "args": [
        "compose", "-f", "infra/docker-compose.yml",
        "--profile", "tools", "run", "--rm", "-T", "mcp"
      ],
      "cwd": "/absolute/path/to/payana-tec-challenge"
    }
  }
}
```

Or, with pnpm on the host and `.env` filled in:

```json
{
  "mcpServers": {
    "conciliacion": {
      "command": "pnpm",
      "args": ["--filter", "@aa/mcp", "exec", "tsx", "src/main.ts"],
      "cwd": "/absolute/path/to/payana-tec-challenge"
    }
  }
}
```

Run `make demo` at least once first. The tools read persisted results; with no
run in the database they answer `no run found`, correctly.

## A session, against the real data

This is a transcript of the actual tools, not an illustration.

**1. Where do we stand?**

```
get_run_summary()
```
```json
{
  "runId": "run_20260921161140",
  "batches": 56,
  "byStatus": { "CONFIRMED": 39, "PROBABLE": 14, "UNMATCHED": 3 },
  "deductions":  { "formatted": "$9.736.628,84" },
  "expectedNet": { "formatted": "$245.472.199,16" },
  "observedNet": { "formatted": "$215.739.967,16" },
  "unexplained": { "formatted": "$29.732.232,00" }
}
```

Fifty-three settlements close and three do not. The agent now has somewhere to
start rather than a file to read.

**2. Show me the ones that did not match.**

```
list_exceptions(status: "unmatched", limit: 1)
→ 3 total, first is mat_34ad35deca5ea21d
```

**3. Why not this one?**

```
explain_match(matchId: "mat_34ad35deca5ea21d")
```
```json
{
  "band": "UNMATCHED",
  "disqualifiedBy": "AMOUNT_MISMATCH",
  "components": [{
    "code": "SETTLEMENT_MERGED",
    "expected": "una acreditación propia de $25.936.896,00",
    "observed": "2026-02-24 $28.145.645,23",
    "detail": "parece haberse cobrado junto con el corte del 2026-02-23: los dos suman $29.414.683,00 y el crédito está 4,31% por debajo, dentro de lo que el canal puede cobrar"
  }]
}
```

Everything the agent needs to write the finding is there, and none of it is
prose it has to trust: the batch has no credit of its own, and the one credit
that fits is two batches paid together. The system says so instead of forcing
a match, and the detail is assembled from the amounts, not written by a model.

An agent that cites `SETTLEMENT_MERGED` here is saying something checkable.
That is the whole point of the closed vocabulary.

## What is deliberately not here

No matching by model, now or later.

Determinism is the product. A reconciliation a CFO takes to an audit cannot
change between runs, and there is no volume of data here that a model would
handle better than a rule with a weight on it. Explainability would get worse,
not better: today every point of the score has a name, a weight and a line in
`config/ruleset.v1.json` that anyone can argue with.

```
        ┌──────────────────────────────────────────┐
        │  Agent                                   │
        │  queries · explains · writes the report  │
        └────────────────────┬─────────────────────┘
                             │  read-only, schema-validated
        ┌────────────────────▼─────────────────────┐
        │  DETERMINISTIC CORE                      │
        │  parsers · versioned rules · rubric      │  ← money is decided here,
        └──────────────────────────────────────────┘     and only here
```

Knowing where a model helps and where it gets in the way is worth more than
putting one on an arithmetic problem.
