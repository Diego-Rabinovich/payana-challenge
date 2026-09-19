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
24 settlements are ambiguous, pulls one, and asks why. It reads a few kilobytes
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
stays in the CLI behind `--confirm`, where a person typed it. A test asserts no
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
  "runId": "run_20260919205402",
  "rulesetVersion": "v1",
  "batches": 65,
  "byStatus": { "PROBABLE": 31, "AMBIGUOUS": 24, "UNMATCHED": 10 },
  "expectedNet":  { "cents": 25520882800, "formatted": "$255.208.828,00" },
  "observedNet":  { "cents": 24388914211, "formatted": "$243.889.142,11" },
  "unexplained":  { "cents": 1131968589,  "formatted": "$11.319.685,89" },
  "unattributedCredits": 150
}
```

Eleven million pesos unaccounted for, and 24 settlements the system refused to
decide. The agent now has somewhere to start rather than a file to read.

**2. Show me one of the ambiguous ones.**

```
list_exceptions(status: "ambiguous", limit: 1)
→ 24 total, first is mat_6b6f90a5ce23b12b
```

**3. Why can you not decide this one?**

```
explain_match(matchId: "mat_6b6f90a5ce23b12b")
```

```
batch 2026-01-03   window 2026-01-05 → 2026-01-07
gross      $195.700,00
expected   $195.700,00
observed   $4.820.714,76

score 48  (65 of 135 attainable)

  AMOUNT_MISMATCH          ✗   delta COP 462501476
  DATE_T1_EXACT            ✓
  DESCRIPTOR_MATCH         ✓
  IDENTITY_BROKEN          ✗   source reported no deductions to verify
  SETTLEMENT_SINGLE_CREDIT ✓
  COMPETING_CANDIDATE      ✗   runner-up scored 41

  discarded: mov_38cdcd5722b9c6a9  41  AMOUNT_MISMATCH
             mov_4938a79f88768e19  37  AMOUNT_MISMATCH
             mov_f86d913b5025218f  30  AMOUNT_MISMATCH
```

Everything the agent needs to write the finding is there, and none of it is
prose it has to trust. A Saturday batch of $195.700 against a Monday credit of
$4.820.714 — the date and the counterparty line up, the amount is nowhere near,
and three other credits scored almost as well. The honest answer is that this
batch cannot be matched from a statement alone, and the system says so instead
of picking the closest number.

An agent that cites `COMPETING_CANDIDATE` and `AMOUNT_MISMATCH` here is saying
something checkable. That is the whole point of the closed vocabulary.

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
