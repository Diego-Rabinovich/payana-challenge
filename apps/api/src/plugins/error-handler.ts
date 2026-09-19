import { DomainError } from '@aa/core';
import type { FastifyInstance } from 'fastify';

/**
 * Every failure leaves this API as RFC 9457 `application/problem+json`.
 *
 * Domain errors carry a code, so the mapping is a table rather than string
 * matching on messages — which means renaming an error message can never
 * silently change an HTTP status.
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_MONEY: 422,
  PARSE_INTEGRITY: 422,
  UNKNOWN_LAYOUT: 422,
  SOURCE_UNAVAILABLE: 503,
  CONFIGURATION: 500,
};

const PROBLEM_BASE = 'https://alcazar.example/problems';

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(readonly resource: string) {
    super(`${resource} not found`);
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const problem = describe(error, request.url);

    // Anything we did not plan for is a defect: log it with the stack rather
    // than leaking internals into the response.
    if (problem.status >= 500) request.log.error({ err: error }, 'unhandled failure');

    void reply.status(problem.status).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .type('application/problem+json')
      .send({
        type: `${PROBLEM_BASE}/not-found`,
        title: 'Resource not found',
        status: 404,
        instance: request.url,
        code: 'NOT_FOUND',
      });
  });
}

function describe(error: unknown, instance: string) {
  if (error instanceof NotFoundError) {
    return {
      type: `${PROBLEM_BASE}/not-found`,
      title: 'Resource not found',
      status: 404,
      detail: error.message,
      instance,
      code: error.code,
    };
  }

  if (error instanceof DomainError) {
    const status = STATUS_BY_CODE[error.code] ?? 500;
    return {
      type: `${PROBLEM_BASE}/${error.code.toLowerCase().replace(/_/g, '-')}`,
      title: error.name,
      status,
      detail: error.message,
      instance,
      code: error.code,
    };
  }

  const validation = (error as { statusCode?: number; message?: string }).statusCode;
  if (validation && validation < 500) {
    return {
      type: `${PROBLEM_BASE}/invalid-request`,
      title: 'Invalid request',
      status: validation,
      detail: (error as Error).message,
      instance,
      code: 'INVALID_REQUEST',
    };
  }

  return {
    type: `${PROBLEM_BASE}/internal`,
    title: 'Internal Server Error',
    status: 500,
    instance,
    code: 'INTERNAL',
  };
}
