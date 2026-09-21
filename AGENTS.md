# Working in this repository

Read this before changing anything. It is meant to be enough on its own: after
it you should be able to run the tests, add a parser and explain a match
without opening an ADR.

## The domain in ten lines

A restaurant chain takes card payments through Wompi. Wompi nets a day of
sales against its fees and transfers the remainder to a Bancolombia account
the next business day. Odoo is the formal book of record.

Three questions, in order:

1. **Ingestion** — can every source be expressed as signed movements in one
   model, each traceable back to the bytes it came from?
2. **Channel → bank** — did the money the gateway promised actually arrive?
3. **Ledger → ERP** — does the book of record say what really happened?

Everything in the repository exists to answer one of those three and to show
its work.

## Where things live

```
packages/core        the domain. No I/O, no framework, no npm dependency
                     beyond a date primitive
packages/adapters    the outside world in both directions: Wompi, Bancolombia
                     PDFs, Odoo, Postgres, and the presenters
packages/contracts   the wire. Zod DTOs and the evidence vocabulary
apps/api             REST + OpenAPI
apps/cli             the batch pipeline and its report artifacts
apps/web             the console
apps/mcp             read-only tools for an AI client
config/*.json        every threshold, weight, rate, holiday and account code
docs/adr             the decisions, with what lost and why
docs/spec            what each phase builds and how it is tested
```

Dependencies point inwards. `dependency-cruiser` fails the build when they do
not, and both rules below were verified by deliberately breaking them.

## Commands

```bash
make up        # db + api + web in Docker. Console :8090, API :3100, db :5433
make demo      # ingest → reconcile both phases → write data/out/report.{md,json}
make check     # boundaries, types, tests. This is the gate
make down
```

`make check` runs on the host and needs `corepack enable pnpm && pnpm install`.
Everything else runs in Docker.

## Conventions

**Money is integer cents.** `Money` has a private constructor and no float
ever touches it. Wompi truncates rather than rounds, so `scaleInteger` takes
an explicit rounding mode and the caller has to choose one.

**Dates are `Temporal.PlainDate`.** The settlement window is counted in
business days against a versioned holiday table in
`config/holidays-co.json`, not computed — Colombia moves several holidays to
the following Monday and a static reviewable table is auditable where an
algorithm would be a pile of edge cases.

**The ledger is single entry.** A movement is one signed amount. Debits and
credits exist in exactly one file, `packages/adapters/src/odoo/journal-entry-builder.ts`,
because they are Odoo's convention and not the domain's. If you find yourself
writing `debit` anywhere else, the design has drifted.

**Config over constants.** A threshold, a weight, a rate or a cadence belongs
in `config/*.json` with a version, not in a `const`. Results carry the ruleset
version so they can be reproduced.

**Evidence codes over prose.** A conclusion is explained by codes from a closed
list, never by a generated sentence. The list lives in
`packages/core/src/domain/evidence.ts` and is published as a Zod enum in
`packages/contracts/src/evidence-codes.ts`. Adding a code means editing both —
a test asserts they are identical, and the frontend will not compile until the
code has a Spanish phrase.

**Rules find, they do not judge.** A `MatchingRule` proposes candidates. Which
one wins is decided once, over the whole field, in
`packages/core/src/rules/assignment.ts`. Rules cannot see each other and none
of them decides uniqueness.

## Boundaries that will fail the build

- `apps/web` may import `@aa/contracts` and nothing else. Not `@aa/core`, not
  `@aa/adapters`.
- `packages/core` takes no npm dependency except `@js-temporal/polyfill`. No
  HTTP client, no database driver, no PDF library, no Zod.
- `packages/adapters` may import `core` and `contracts`. Never the reverse.

## What must not be touched

These are production credentials against a live business.

- **Never change Wompi's events URL** or rotate a key.
- **Never create a transaction** in Wompi, test or otherwise.
- **Writing to Odoo stays off.** `ODOO_WRITE_ENABLED=false` is the default and
  the CLI additionally requires `--confirm`. Existing entries are never
  modified or deleted; a discrepancy is reported and correcting it is a human
  decision.
- **No credentials or unscrubbed personal data in the repository.** Raw
  payloads go to `data/raw/`, which is ignored.
- **The MCP server has no write tools and never will.** Creating entries in a
  production ERP does not belong one prompt away.

## Adding things

**A new source** is a parser in `packages/adapters` (and a connector only if
the transport is new), two lines in `composition.ts` — its connector and its
parser, each carrying its own id; the pipeline ingests whatever is registered —
and its
descriptors in `config/descriptors.json`. If it batches on a different
schedule, that is a `settlement` block on its channel in
`config/ruleset.v1.json` — `cadence`, and for a weekly channel `weekEndsOn`.
None of that touches `core`; dependency-cruiser fails the build if `core`
starts importing from `adapters`.

**A new matching rule** is a class implementing `MatchingRule` plus a line in
the composition root. Do not add ordering logic: every rule runs and the score
decides.

**A new evidence code** is three edits — core, contracts, and the phrase table
in `apps/web/src/lib/evidence-phrases.ts` — plus a weight in the ruleset if it
should count. Adding a weight changes the attainable maximum, so check the
bands still mean what they meant.

## Where the money is decided

Only in `packages/core`, deterministically, from versioned rules. No model is
ever in that path. An AI client reads results through `apps/mcp`; it does not
compute them. That separation is deliberate and is the one thing in this
repository not to redesign.
