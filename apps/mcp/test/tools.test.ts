import { describe, expect, it } from 'vitest';
import {
  ErpReconciliationDto,
  EVIDENCE_CODES,
  MoneyDto,
  ReconciliationDto,
  UnattributedCreditDto,
} from '@aa/contracts';
import { TOOLS, toolNamed } from '../src/tools.js';
import { stubReadModel } from './support/stub-read-model.js';

/**
 * Spec 06, F06-T01 to T03.
 *
 * What is worth testing here is not the protocol, it is the three promises the
 * tools make: they return exactly what the HTTP API returns, they change
 * nothing, and they never let an agent invent a category.
 */

const model = stubReadModel();

describe('the tool surface', () => {
  it('describes every tool well enough for an agent to call it', () => {
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      // A one-word description is the difference between a tool an agent uses
      // correctly and one it guesses at.
      expect(tool.description.length).toBeGreaterThan(40);
    }
    expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(TOOLS.length);
  });

  it('exposes no tool that writes (F06-T02)', () => {
    const forbidden = /create|post|update|delete|write|set_|approve/;
    expect(TOOLS.filter((tool) => forbidden.test(tool.name))).toEqual([]);
  });
});

describe('F06-T01 · output validates against the published DTOs', () => {
  it('list_exceptions returns ReconciliationDto items', async () => {
    const result = (await toolNamed('list_exceptions')!.run({ limit: 20, offset: 0 }, model)) as {
      total: number;
      exceptions: unknown[];
    };

    expect(result.total).toBe(2);
    for (const exception of result.exceptions) {
      expect(ReconciliationDto.safeParse(exception).success).toBe(true);
    }
  });

  it('explain_match returns the full evidence for one result', async () => {
    const result = await toolNamed('explain_match')!.run({ matchId: 'mat_one' }, model);
    const parsed = ReconciliationDto.safeParse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.confidence.components.length).toBeGreaterThan(0);
    // The discarded candidates travel with it: without them "ambiguous" is an
    // assertion rather than an explanation.
    expect(parsed.data?.alternatives).toBeDefined();
  });

  it('list_unattributed_credits returns UnattributedCreditDto items', async () => {
    const result = (await toolNamed('list_unattributed_credits')!.run({ limit: 50 }, model)) as {
      credits: unknown[];
    };

    expect(result.credits).toHaveLength(1);
    expect(UnattributedCreditDto.safeParse(result.credits[0]).success).toBe(true);
  });

  it('get_erp_discrepancies returns ErpReconciliationDto', async () => {
    const result = await toolNamed('get_erp_discrepancies')!.run({ journalKey: 'wompi' }, model);
    expect(ErpReconciliationDto.safeParse(result).success).toBe(true);
  });

  it('get_run_summary returns the funnel as formatted amounts', async () => {
    const result = (await toolNamed('get_run_summary')!.run({}, model)) as Record<string, unknown>;

    expect(result['batches']).toBe(2);
    expect(result['rulesetVersion']).toBe('v1-test');
    // A MoneyDto, not a stringified object: an agent quoting a figure quotes
    // the same string the CFO sees on screen.
    expect(MoneyDto.safeParse(result['expectedNet']).success).toBe(true);
    expect((result['expectedNet'] as { formatted: string }).formatted).toMatch(/^\$/);
  });
});

describe('F06-T03 · the vocabulary is closed and published', () => {
  it('get_evidence_codes returns every code with its dimension', async () => {
    const result = (await toolNamed('get_evidence_codes')!.run({}, model)) as {
      codes: { code: string; dimension: string }[];
    };

    expect(result.codes).toHaveLength(EVIDENCE_CODES.length);
    for (const entry of result.codes) {
      expect(entry.dimension).toBeTruthy();
    }
  });

  it('never returns a code outside the published list', async () => {
    const match = await toolNamed('explain_match')!.run({ matchId: 'mat_one' }, model);
    const parsed = ReconciliationDto.parse(match);

    for (const component of parsed.confidence.components) {
      expect(EVIDENCE_CODES).toContain(component.code);
    }
  });
});

describe('failures are messages, not exceptions', () => {
  it('says so when an id does not exist', async () => {
    // El error nombra la corrida: un id de match existe o no *dentro de una*,
    // y decir cual se miro es la diferencia entre un error util y uno mudo.
    expect(await toolNamed('explain_match')!.run({ matchId: 'nope' }, model)).toEqual({
      error: 'no match nope in run run_test',
    });
    expect(await toolNamed('trace_movement')!.run({ movementId: 'nope' }, model)).toEqual({
      error: 'no movement nope',
    });
  });

  it('una corrida que no existe se dice, no se sustituye por la ultima', async () => {
    expect(
      await toolNamed('explain_match')!.run({ matchId: 'mat_one', runId: 'run_inventada' }, model),
    ).toEqual({ error: 'no run run_inventada' });
  });

  it('rejects a limit outside the range instead of paging the world', () => {
    const tool = toolNamed('list_exceptions')!;
    expect(tool.input.safeParse({ limit: 5000 }).success).toBe(false);
    expect(tool.input.safeParse({ limit: 20 }).success).toBe(true);
  });
});
