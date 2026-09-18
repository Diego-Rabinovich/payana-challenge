/**
 * Domain errors. Typed so the API can map each one to an RFC 9457 status
 * without string matching, and so nothing is swallowed silently.
 */

export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** An amount that is not a safe integer number of cents, or a currency mismatch. */
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

/**
 * A parsed document failed one of its own control checks (balance chain,
 * summary totals, accounting identity). We reject the whole parse rather than
 * return partial data: reconciling over a silently incomplete ledger is worse
 * than not reconciling. See ADR-0009.
 */
export class ParseIntegrityError extends DomainError {
  readonly code = 'PARSE_INTEGRITY';

  constructor(
    message: string,
    context: {
      readonly sourceId: string;
      readonly locator?: string;
      readonly expected?: string;
      readonly observed?: string;
    },
  ) {
    super(message, context);
  }
}

/** No registered parser recognised the document. */
export class UnknownLayoutError extends DomainError {
  readonly code = 'UNKNOWN_LAYOUT';
}

/** A source could not be reached. The run continues and marks it stale. */
export class SourceUnavailableError extends DomainError {
  readonly code = 'SOURCE_UNAVAILABLE';
}

/** Configuration failed its schema at boot. Fatal on purpose. */
export class ConfigurationError extends DomainError {
  readonly code = 'CONFIGURATION';
}

/**
 * Exhaustiveness guard for literal unions. TypeScript rejects the call at
 * compile time if a case is unhandled; this throws if one slips through at
 * runtime (e.g. data from outside the type system).
 */
export function assertNever(value: never, what = 'value'): never {
  throw new Error(`Unhandled ${what}: ${JSON.stringify(value)}`);
}
