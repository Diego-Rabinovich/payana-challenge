# ADR-0003 — Separate transport from format in ingestion

**Status:** Accepted · **Date:** 2026-09-17

## Context

The brief asks that adding a source be cheap, and that the design tolerate independent variation in **format** (PDF layout A, PDF layout B, REST JSON, webhook, Excel, CSV) and in **connection type** (API call, local file, webhook).

## Decision

Two orthogonal ports:

- **`SourceConnector`** — the *how it is obtained*: `fetch(range) → AsyncIterable<RawRecord>`.
- **`RecordParser`** — the *how it is interpreted*: `canParse(raw) → boolean` and `parse(raw) → CanonicalRecord[]`.

The pipeline is written once: `fetch → resolve parser → parse → normalise → validate → deduplicate → persist`.

`canParse()` acts as a sniffer and is what lets layout A and layout B coexist without touching the pipeline: the registry tries parsers and picks the one that recognises the document. It is the same `identify()/extract()` protocol used by Beancount importers.

Sources are declared in `config/sources.json`, not in code.

## Alternatives considered

- **One monolithic adapter per source** (connection and parsing together). Simpler to write the first time, but it forces duplicating transport when two sources share a connection and differ in format — exactly Wompi's case, which arrives via API, via panel export and via webhook.
- **A single parser driven by declarative JSON.** Tempting, but a PDF statement with balance-chain validation cannot be reasonably expressed in configuration; it would end up as a badly built programming language.

## Consequences

> **Correction (2026-09-21).** The declarative half of this decision was never
> built. `config/sources.json` existed and was never read: connectors and
> parsers are constructed in `composition.ts`, and the run pipeline ingests
> every registered connector, so a new source is two lines there — its
> connector and its parser — not a config entry. The file was removed rather than kept as
> documentation that looked like configuration. The separation of transport
> from format — the substance of this ADR — stands and is what the code does.

**Cost of a new source:** one `RecordParser` (~80 lines), one entry in `config/sources.json`, a fixture and its test. If the transport is also new, one `SourceConnector` (~40 lines). Zero changes in `core`, in the API or in the frontend.

That is demonstrated with an isolated commit (UberEats) and documented in `docs/ADDING-A-SOURCE.md`, which is the answer to the brief's "show it".

**Cost accepted:** two interfaces instead of one, and a registry to resolve. That is the price of keeping the transport axis and the format axis from contaminating each other.
