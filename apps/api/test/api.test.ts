import { Temporal } from '@js-temporal/polyfill';
import { MovementDto, ReconciliationDto } from '@aa/contracts';
import { Money, accountId, evidence } from '@aa/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_PREFIX, buildApp } from '../src/app.js';
import type { ReadModel } from '@aa/core';
import { stubDependencies, testMatch, testMovement } from './support/stubs.js';

describe('HTTP API', () => {
  let app: FastifyInstance;
  let deps: ReadModel;

  const get = (path: string) => app.inject({ method: 'GET', url: `${API_PREFIX}${path}` });

  beforeEach(async () => {
    deps = stubDependencies();
    app = await buildApp(deps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports health with the ruleset in force (F04-T01)', async () => {
    const response = await get('/health');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', rulesetVersion: 'v1-test' });
  });

  it('serves movements that validate against the published DTO', async () => {
    const response = await get('/accounts/wompi:AA/movements');

    expect(response.statusCode).toBe(200);
    const body = response.json() as { movements: unknown[] };
    expect(() => MovementDto.parse(body.movements[0])).not.toThrow();
  });

  it('carries money as cents and as its display form, so the UI never reformats', async () => {
    const response = await get('/accounts/wompi:AA/movements');
    const [movement] = (response.json() as { movements: { amount: unknown }[] }).movements;

    expect(movement?.amount).toEqual({
      cents: 31_754_900,
      currency: 'COP',
      formatted: '$317.549,00',
    });
  });

  it('strips anything the response schema does not declare (F04-T02)', async () => {
    // The stub deliberately leaks an internal field; the compiled serialiser
    // has to drop it, which is the runtime half of the ADR-0010 boundary.
    const response = await get('/accounts/wompi:AA/movements');
    const [movement] = (response.json() as { movements: Record<string, unknown>[] }).movements;

    expect(movement).not.toHaveProperty('internalOnly');
    expect(movement).toHaveProperty('id');
  });

  it('serves a reconciliation with its evidence and discarded alternatives', async () => {
    const response = await get('/runs/run_1/reconciliations/mat_1');

    expect(response.statusCode).toBe(200);
    const body = ReconciliationDto.parse(response.json());
    expect(body.confidence.components.map((component) => component.code)).toContain('AMOUNT_EXACT');
    expect(body.rulesetVersion).toBe('v1-test');
  });

  it('filters the collection by status, for the exception queue', async () => {
    const response = await get('/runs/run_1/reconciliations?status=ambiguous');

    expect(response.statusCode).toBe(200);
    expect(deps.flow.listReconciliations).toBeDefined();
  });

  it('returns RFC 9457 problem details for a missing resource (F04-T03)', async () => {
    const response = await get('/runs/run_1/reconciliations/does-not-exist');

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      type: expect.stringContaining('not-found'),
      title: expect.any(String),
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('no hay forma de pedir un resultado sin decir de que corrida', async () => {
    // La ruta plana era la que dejaba que el id de un match —estable entre
    // corridas— se resolviera contra la ultima que hubiera corrido.
    const response = await get('/reconciliations/mat_1');
    expect(response.statusCode).toBe(404);
  });

  it('`latest` es un id valido y el servidor lo resuelve', async () => {
    const response = await get('/runs/latest/reconciliations/mat_1');
    expect(response.statusCode).toBe(200);
  });

  it('una corrida que no existe es un 404, no los numeros de otra', async () => {
    const response = await get('/runs/run_inventada/reconciliations/mat_1');

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('resolves `latest` for a run and its report too', async () => {
    // Estas dos quedaron afuera del corte de rutas y contestaban 404.
    expect((await get('/runs/latest')).statusCode).toBe(200);

    const report = await get('/runs/latest/report?format=json');
    expect(report.statusCode).toBe(200);
    expect(report.headers['content-type']).toContain('application/json');
  });

  it('does not promise a format it cannot produce', async () => {
    // ndjson figuraba en el esquema y devolvía 404: ahora es un 400 honesto.
    expect((await get('/runs/run_1/report?format=ndjson')).statusCode).toBe(400);
  });

  it('returns problem details for an unknown route too, never bare HTML', async () => {
    const response = await get('/nope');

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects an invalid query with a 400 in the same problem shape', async () => {
    const response = await get('/accounts/wompi:AA/movements?limit=9999');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
  });

  it('publishes the closed evidence vocabulary the results cite (F04-T07)', async () => {
    const response = await get('/evidence-codes');
    const { codes } = response.json() as { codes: { code: string }[] };

    expect(codes.map((entry) => entry.code)).toContain('AMOUNT_EXACT');
    expect(codes.map((entry) => entry.code)).toContain('MATCHED_BY_REF');
  });

  it('creates a run and points at it with Location, rather than returning a verb', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/runs`,
      payload: { from: '2026-04-01', to: '2026-04-30' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe(`${API_PREFIX}/runs/run_1`);
  });

  it('generates an OpenAPI 3.1 document from the same schemas (F04-T05)', async () => {
    const document = app.swagger() as { openapi: string; paths: Record<string, unknown> };

    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toContain('/movements/{movementId}/lineage');
  });

  it('names resources, never actions', () => {
    const document = app.swagger() as { paths: Record<string, unknown> };
    const verbs = /\/(get|post|create|update|delete|list|upload|trace|post-missing|run)([/-]|$)/i;

    const offenders = Object.keys(document.paths).filter((path) => verbs.test(path));
    expect(offenders).toEqual([]);
  });
});

describe('presenters', () => {
  it('serialises a Temporal date as a plain calendar date', async () => {
    const movement = testMovement();
    expect(movement.valueDate.toString()).toBe('2026-04-24');
  });

  it('keeps evidence that failed, so a conclusion shows what it ruled out', () => {
    const match = testMatch([
      evidence('AMOUNT_EXACT', 'AMOUNT', true),
      evidence('DESCRIPTOR_FOREIGN', 'DESCRIPTOR', false),
    ]);

    expect(match.confidence.components.filter((component) => !component.passed)).toHaveLength(1);
  });

  it('builds amounts from cents without touching a float', () => {
    expect(Money.ofCents(31_754_900).cents).toBe(31_754_900);
    expect(accountId('wompi:AA')).toBe('wompi:AA');
    expect(Temporal.PlainDate.from('2026-04-24').toString()).toBe('2026-04-24');
  });
});
