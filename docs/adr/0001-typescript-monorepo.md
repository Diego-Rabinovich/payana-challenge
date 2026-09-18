# ADR-0001 — TypeScript and pnpm monorepo, over Java + Spring Boot

**Status:** Accepted · **Date:** 2026-09-17

## Context

The system needs a backend, a frontend and a headless tool, and it has two consumers of the same information: a CFO and an AI accountant. The brief leaves the language free but asks us to justify the choice. The timebox is about one week.

## Decision

TypeScript across the monorepo, with pnpm workspaces. Backend on Fastify with the domain in a pure package that knows no framework; frontend on React + Vite.

## Alternatives considered

### Java 21 + Spring Boot (the serious alternative)

**Real advantages, which are worth stating plainly:**

- **`java.time` is better.** Phase 2 revolves around business-day arithmetic in `America/Bogota`. JavaScript's `Date` is poor; you have to bring in Temporal or Luxon.
- **PDFBox and tabula-java beat the Node ecosystem for PDFs.** `PDFTextStripperByArea` extracts by region and tabula extracts tables outright. In Node you cluster `pdfjs-dist` text items by coordinate yourself. **The PDF argues for Java, not against it.**
- **`sealed interface` plus pattern matching gives compiler-verified exhaustiveness.** TypeScript's discriminated unions get close with `assertNever`, but it is opt-in.
- **Module boundaries are physical.** A Gradle module without Spring on its classpath is stronger than a lint rule, and ArchUnit is a better tool than `dependency-cruiser`.
- **Spring profiles** solve with configuration what here is an `if` in a factory.

**Why not, anyway:** two toolchains in the monorepo (Gradle + pnpm), a duplicated contract between back and front that has to be generated, and a slower iteration cycle. Over seven days that is paid in delivered surface.

### TypeScript + NestJS

Gives DI and conventional structure, but the framework *performs* clean architecture instead of showing it, and puts decorators near the domain. Rejected as unnecessary: with six use cases, a 40-line composition root is more explicit.

### Python

Better PDF parsing and native `xmlrpc`, but it breaks the single contract with the frontend. Kept as a narrow plan B if the PDFs prove intractable (see ADR-0009).

## Consequences

**In favour:** one toolchain; the API contract is defined once in Zod and yields validation, JSON Schema, OpenAPI and frontend types; fast iteration.

**Against, and worth watching:**

- Interfaces are erased at runtime: the ports-and-adapters discipline rests on convention and lint, not on the compiler. Compensated by `dependency-cruiser` (ADR-0010) and **per-port contract tests**, which additionally verify semantics no type system can express.
- Exhaustiveness when adding a case to a union is opt-in: `assertNever` has to be used systematically.
- PDF parsing will cost more work than it would in Java. That is a price accepted knowingly.

## Notes

The decision was made after an analysis in which **Java came out ahead on modelling and on PDF handling**. TypeScript was chosen for the schedule and the single contract, not for general technical superiority. If this system were headed to production in a JVM team, the choice would be revisited.
