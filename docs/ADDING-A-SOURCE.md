# Adding a new source

The brief asks how much code it takes to add a source — say AA integrates the POS or UberEats tomorrow. This guide is the answer, and it is reproducible: follow it and you will not touch a single line of `packages/core`.

## The idea

Ingestion separates two independent axes:

- **Transport** (`SourceConnector`): how the bytes are obtained — local file, HTTP API, webhook, SFTP.
- **Format** (`RecordParser`): how those bytes are interpreted — CSV, PDF layout A, PDF layout B, JSON.

Almost every new source **reuses an existing transport** and contributes only a parser.

## Steps

### 1. Get a sample and anonymise it

Put the raw file in `data/raw/` (gitignored) and run it through the scrubber before it reaches `data/fixtures/`. Amounts and dates are preserved untouched: they are what the system reconciles. See [ADR-0012](adr/0012-live-credentials.md).

### 2. Write the parser

One file under `packages/adapters/src/<source>/`, implementing `RecordParser`:

- **`canParse(raw)`** — recognises whether this document is its own. This is what lets layouts coexist without touching the pipeline.
- **`parse(raw)`** — returns canonical movements.

Three non-negotiable obligations:

1. **Normalise to cents.** No pesos and no decimals escape the parser.
2. **Populate `SourceRef` with a precise `locator`** (page and row, or transaction id). Without it the system's explanation stops short of the original data.
3. **Validate an integrity invariant and fail if it breaks** ([ADR-0009](adr/0009-fail-closed-parsers.md)). Almost every financial document carries its own control: a running balance, a control total, an arithmetic identity. Find it and use it. If there genuinely is none, document why inside the parser.

### 3. Write the connector, if the transport is new

Another file implementing `SourceConnector`. If an existing one fits (`LocalFileConnector`, `HttpApiConnector`, `WebhookInboxConnector`), this step does not exist.

### 4. Declare the source

One entry in `config/sources.json`: id, connector, parser, target account and cadence. **Nothing is registered in code.**

### 5. If the source brings new concepts

Map them onto existing canonical types. If a genuinely new one is needed, add it to `MovementType` **and** to `config/odoo-accounts.json`: a type without an account emits `NO_ACCOUNT_MAPPING` and the system reports it rather than hiding it.

### 6. Tests

- A fixture and a parse test with expected counts and amounts.
- An invariant test: **mutilate the fixture deliberately** (delete a row, alter one cent) and verify the parse fails.
- Add the source to the contract-test suite of the relevant port.

## What must not be touched

`packages/core`, the ingestion pipeline, the API, the frontend, the rules engine.

If any of those is needed, it is a signal that the canonical model fell short: that is a design conversation and an ADR, not a patch in the parser.

## Verification

```bash
git diff --stat
```

Only files under `packages/adapters/src/<source>/`, `config/sources.json`, `data/fixtures/<source>/` and the tests should appear. That diff **is** the demonstration the brief asks for.

## Estimated budget

| Piece | Lines |
|---|---:|
| `RecordParser` | ~80 |
| `SourceConnector` (only if the transport is new) | ~40 |
| `config/sources.json` entry | 6 |
| Tests | ~60 |
