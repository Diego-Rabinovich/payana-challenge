# Adding a new source

*Written for: whoever has to wire up the POS, UberEats or the next gateway.*

The brief asks how much code a new source takes. The answer is **a parser and
a config entry**, and the diff at the end of this page is how you check it.

## The idea

Ingestion separates two axes that vary independently:

- **Transport** (`SourceConnector`) — how the bytes arrive: a file, an HTTP API, a webhook.
- **Format** (`RecordParser`) — how those bytes are read: a PDF layout, a JSON payload.

Wompi arrives over HTTP and Bancolombia as a PDF, but a Wompi export saved to
disk would be the *same parser* over a different transport. That asymmetry is
the whole reason the two are separate.

Two transports are built today: `LocalFileConnector` (a folder on disk) and
`WompiTransactionsConnector` (a paginated HTTP API). Odoo is read by
`OdooErpGateway`, outside the connector registry.

## Steps

### 1. Get a sample, and anonymise it

Real documents are never committed. Work with them in `data/raw/` (gitignored);
a test that needs the real thing should skip when it is absent, as the
Bancolombia parser suite does. If you commit a sample, strip the personal data
but **never alter amounts or dates**: they are what the system reconciles, and
changing one makes the sample a lie.

### 2. Write the parser

One file under `packages/adapters/src/<source>/`, implementing `RecordParser`:

- **`canParse(raw)`** — recognises its own documents. This is what lets two
  layouts of the same bank coexist without a branch in the pipeline.
- **`parse(raw)`** — returns canonical movements.

Three obligations that are not negotiable:

1. **Normalise to integer cents.** No floats, no pesos with decimals, ever.
2. **Fill `SourceRef.locator`** — page and row, or a transaction id. Without it
   the explanation stops one step short of the document, which is the step that
   matters to an auditor.
3. **Find an integrity invariant and fail on it**
   ([ADR-0009](adr/0009-fail-closed-parsers.md)). Almost every financial
   document carries its own control: a running balance, a control total, an
   arithmetic identity. A parser that trusts the document produces a ledger
   that looks fine and reconciles against nothing. If the format genuinely has
   no control, say so in a comment in the parser.

### 3. Write a connector only if the transport is new

If the bytes come from a file or from an HTTP API, reuse what is there.

### 4. Declare it

One constructor call in `composition.ts`, where the connector and parser
registries are built. That is the only line that knows the class exists.

### 5. If it brings new concepts

Map them onto the existing `MovementType`s first. A genuinely new type has to
be added to the union **and** to `config/odoo-accounts.json`: a type with no
account emits `NO_ACCOUNT_MAPPING`, which is reported rather than hidden.

This is the one step that touches `packages/core`, and it should be rare — the
test of a canonical model is that a new source does not extend it.

### 6. Tests

- A parse test against the fixture, with expected counts and amounts.
- **An invariant test that mutilates the fixture on purpose** — delete a row,
  change one cent — and asserts the parse *fails*. Without this one, nothing
  proves the safeguard in step 2.3 is wired.

## Verification

```bash
git diff --stat
```

Only `packages/adapters/src/<source>/`, one line of `composition.ts`, its
descriptors in `config/descriptors.json` and the tests should appear. Anything else — core, the pipeline, the API, the frontend, the rules —
means the canonical model fell short, and that is an ADR, not a patch.

| Piece | Lines |
|---|---:|
| `RecordParser` | ~80 |
| `SourceConnector`, only if the transport is new | ~40 |
| `composition.ts` | 1–2 |
| Tests | ~60 |
