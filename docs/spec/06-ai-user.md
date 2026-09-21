# Spec 06 — The AI user

> Status: 📝 Draft · Depends on: [04](04-api-outputs.md)

The brief names two users, and both count: a CFO who reads, and *"an AI accountant that needs to consume the information programmatically and reason over it"*. Specs 04 and 05 serve the first. This one serves the second.

Scope is deliberately narrow: make the repository legible to an agent, and make the results callable by one. Nothing here puts a model on the path where money is computed — see §3.

---

## 1. `AGENTS.md` / `CLAUDE.md` — an agent-legible repository

Half an hour of work, read without installing anything, and an explicit bonus in the brief. It goes first for exactly those reasons.

**Contents:**

| Section | Why an agent needs it |
|---|---|
| Domain in ten lines | Gateway nets a day of sales and transfers T+1; we check it arrived and that the ERP says so |
| Where things live | `core` is the domain, `adapters` the outside world, `contracts` the wire |
| Commands | `make demo`, `make check`, `make up` |
| Conventions | Integer cents, `Temporal` dates, config over constants, evidence codes over prose |
| Boundaries that will fail the build | `apps/web` may import only `@aa/contracts`; `core` takes no npm dependency but the Temporal polyfill |
| What must not be touched | Wompi's events URL, private key rotation, unscrubbed PII, writing to Odoo outside the two sandbox journals |

**Acceptance:** an agent given only this file can run the test suite, add a parser and explain a match without reading the ADRs.

---

## 2. MCP server — results an agent can query

### Why it is worth building

Without it, the only way to hand a year of ledgers to a model is to paste `report.json` into its context. Hundreds of thousands of movements do not fit, and if they did it would be expensive and the model would drown.

MCP turns that into a conversation:

```
list_exceptions(status: "ambiguous", limit: 10)   → ten items with their ids
explain_match("mat_9c21af03")                     → evidence, alternatives, score components
trace_movement("mov_7f3a1b")                      → payment → batch → transfer → credit
```

The agent asks for what it needs. That is the whole benefit; the protocol itself is incidental.

### Tools

| Tool | Returns |
|---|---|
| `get_run_summary` | The funnel: gross → deductions → expected net → credited → difference |
| `list_exceptions` | The work queue, filterable and paginated |
| `explain_match` | Evidence, confidence band and discarded alternatives for one match |
| `trace_movement` | A payment's lineage down to the `RawRecord` |
| `list_unattributed_credits` | Credits no batch claimed |
| `get_evidence_codes` | The closed vocabulary, so an agent cites codes instead of inventing categories |

### Design rules

1. **No tool computes anything.** Every one reads a result already produced deterministically. A model must never be in the path where an amount is decided.
2. **Tools return the same DTOs as the API.** No parallel schemas: the Zod definitions in `@aa/contracts` are what make this cheap.
3. **No write tools.** `PostMissingEntries` is not exposed. Creating entries in a production ERP does not belong one prompt away; it stays in the console, behind a button a person pressed.

### Tests

| ID | Type | Verifies |
|---|---|---|
| F06-T01 | Contract | Each tool's output validates against its DTO |
| F06-T02 | Unit | No tool mutates state |
| F06-T03 | Unit | Every `EvidenceCode` the tools can return is documented |

### Acceptance

The README carries the client configuration block **and a worked example session** showing an agent resolving one exception. A bonus nobody can run is worth very little.

---

## 3. What we will not do with AI, and why

**Matching.** Determinism *is* the product: a CFO cannot take a number that changes between runs to an audit. There is no data volume here that would justify a model, and explainability would get **worse** — today every point of the score has a name and a weight anyone can argue with.

```
 ┌─────────────────────────────────────────┐
 │  Agent                                  │
 │  queries results · explains · reports   │
 └───────────────┬─────────────────────────┘
                 │ read-only tools, schema-validated
 ┌───────────────▼─────────────────────────┐
 │  DETERMINISTIC CORE                     │
 │  parsers · versioned rules · rubric     │ ← money is ALWAYS computed here
 └─────────────────────────────────────────┘
```

Showing that we knew where AI helps and where it gets in the way is worth more than sprinkling a model over an arithmetic problem.

---

## 4. Order

`AGENTS.md` first, MCP second, and both only once the three phases and the UI work. With the core half-finished, an MCP server is decoration.

Adding a new source is **not** in this spec. It is demonstrated by [ADDING-A-SOURCE.md](../ADDING-A-SOURCE.md) and enforced by test F01-T16, which fails if adding a parser touches `core`. What matters there is that the design holds and can be explained, not that a second parser exists.
