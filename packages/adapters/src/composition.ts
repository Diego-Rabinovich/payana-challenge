import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountMap,
  type AccountMapConfig,
  BusinessCalendar,
  type ConnectorRegistry,
  type ErpGateway,
  IngestSource,
  type MovementRepository,
  type ParserRegistry,
  type RawRecordRepository,
  ReconcileErp,
  ReconcileFlow,
  type RecordParser,
  RuleSet,
  type RuleSetConfig,
  type SourceConnector,
  type SourceId,
  ScheduledSettlementRule,
  SplitSettlementRule,
  UnknownLayoutError,
  accountId,
  sourceId,
} from '@aa/core';
import { BancolombiaStatementParser } from './bancolombia/statement-parser.js';
import type { DescriptorConfig } from './bancolombia/descriptor-rules.js';
import { LocalFileConnector } from './fs/local-file-connector.js';
import { OdooClient } from './odoo/odoo-client.js';
import { OdooErpGateway } from './odoo/odoo-erp-gateway.js';
import { PgClient } from './persistence/pg-client.js';
import {
  PgMovementRepository,
  PgRawRecordRepository,
  PgReportStore,
  PgRunRepository,
} from './persistence/pg-repositories.js';
import { WompiClient } from './wompi/wompi-client.js';
import {
  WompiTransactionParser,
  WompiTransactionsConnector,
} from './wompi/transactions-source.js';

/**
 * The composition root: the one place that binds ports to implementations.
 *
 * It lives in `adapters` rather than in an app because there is more than one
 * door — API, CLI and, later, an MCP server — and `apps` may not import each
 * other. Duplicating the wiring three times is not a volume problem, it is a
 * drift problem: a CLI still building a fixture gateway after the API moved to
 * a live one would make `make demo` and the API disagree about the same data,
 * quietly, with no test to catch it. See ADR-0011.
 *
 * It takes a parsed, validated `AppConfig` and never reads `process.env`:
 * which variables exist is an app's business, assembling adapters is this
 * layer's.
 */

export interface AppConfig {
  readonly mode: 'fixtures' | 'live';
  readonly dataDir: string;
  readonly configDir: string;
  readonly databaseUrl: string;
  readonly bancolombiaAccountNumber: string;
  readonly wompi: { readonly baseUrl: string; readonly privateKey: string };
  readonly odoo: {
    readonly url: string;
    readonly database: string;
    readonly userId: number;
    readonly apiKey: string;
    readonly companyId: number;
    readonly writeEnabled: boolean;
  };
}

export interface Dependencies {
  readonly ruleSet: RuleSet;
  readonly accountMap: AccountMap;
  readonly calendar: BusinessCalendar;
  readonly accounts: { readonly wompi: ReturnType<typeof accountId>; readonly bank: ReturnType<typeof accountId> };
  readonly sources: { readonly wompi: SourceId; readonly bank: SourceId };
  readonly repositories: {
    readonly movements: MovementRepository;
    readonly rawRecords: RawRecordRepository;
    readonly runs: PgRunRepository;
    readonly reports: PgReportStore;
  };
  readonly erp: ErpGateway;
  readonly useCases: {
    readonly ingest: IngestSource;
    readonly reconcileFlow: ReconcileFlow;
    readonly reconcileErp: ReconcileErp;
  };
  readonly close: () => Promise<void>;
}

export async function buildDependencies(config: AppConfig): Promise<Dependencies> {
  const files = loadConfigFiles(config.configDir);

  const ruleSet = RuleSet.from(files.ruleset);
  const accountMap = AccountMap.from(files.accounts);
  const calendar = new BusinessCalendar(files.holidays);

  const accounts = {
    wompi: accountId('wompi:AA'),
    bank: accountId(`bancolombia:${config.bancolombiaAccountNumber}`),
  };
  const sources = {
    wompi: sourceId('wompi:transactions'),
    bank: sourceId('bancolombia:statement'),
  };

  const db = new PgClient(config.databaseUrl);
  await db.migrate();

  const repositories = {
    movements: new PgMovementRepository(db),
    rawRecords: new PgRawRecordRepository(db),
    runs: new PgRunRepository(db),
    reports: new PgReportStore(db),
  };

  const wompiClient = new WompiClient({
    baseUrl: config.wompi.baseUrl,
    privateKey: config.wompi.privateKey,
  });

  const connectors = registryOf([
    new WompiTransactionsConnector(sources.wompi, wompiClient),
    new LocalFileConnector(sources.bank, join(config.dataDir, 'fixtures/bancolombia'), '.pdf'),
  ]);

  const parsers = parserRegistryOf([
    new WompiTransactionParser(accounts.wompi),
    new BancolombiaStatementParser({ accountId: accounts.bank, descriptors: files.descriptors }),
  ]);

  const erp = new OdooErpGateway(
    new OdooClient({
      url: config.odoo.url,
      database: config.odoo.database,
      userId: config.odoo.userId,
      apiKey: config.odoo.apiKey,
      companyId: config.odoo.companyId,
    }),
    // The gateway needs the chart to turn a correction into an entry.
    accountMap,
    // Reads are unrestricted; writing needs the flag and an explicit confirm.
    { writeEnabled: config.odoo.writeEnabled },
  );

  return {
    ruleSet,
    accountMap,
    calendar,
    accounts,
    sources,
    repositories,
    erp,
    useCases: {
      ingest: new IngestSource(connectors, parsers, repositories.rawRecords, repositories.movements),
      reconcileFlow: new ReconcileFlow(repositories.movements, calendar, ruleSet, [
        // Order is documentation, not precedence: every rule runs and the
        // score decides. The scheduled rule is listed first because it is
        // the one the brief describes.
        new ScheduledSettlementRule(),
        new SplitSettlementRule(),
      ]),
      reconcileErp: new ReconcileErp(erp, repositories.movements, accountMap, calendar),
    },
    close: () => db.close(),
  };
}

function registryOf(connectors: readonly SourceConnector[]): ConnectorRegistry {
  const byId = new Map(connectors.map((connector) => [connector.id, connector]));
  return {
    get: (id) => {
      const connector = byId.get(id);
      if (!connector) throw new UnknownLayoutError(`No connector registered for ${id}`, { id });
      return connector;
    },
    ids: () => [...byId.keys()],
  };
}

function parserRegistryOf(parsers: readonly RecordParser[]): ParserRegistry {
  return {
    resolve: (raw) => {
      // `canParse` is the sniffer that lets two PDF layouts coexist without
      // the pipeline knowing either of them.
      const parser = parsers.find((candidate) => candidate.canParse(raw));
      if (!parser) {
        throw new UnknownLayoutError('No parser recognised this document', {
          origin: raw.origin,
          sourceId: raw.sourceId,
        });
      }
      return parser;
    },
  };
}

interface ConfigFiles {
  readonly ruleset: RuleSetConfig;
  readonly accounts: AccountMapConfig;
  readonly holidays: string[];
  readonly descriptors: DescriptorConfig;
}

/**
 * Configuration is read once, at boot, and never re-read.
 *
 * A ruleset that could change mid-run would make a result unreproducible,
 * which is the one property the whole confidence model rests on.
 */
function loadConfigFiles(dir: string): ConfigFiles {
  const read = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;

  const holidayFile = read<{ holidays: Record<string, { date: string }[]> }>('holidays-co.json');

  return {
    ruleset: read<RuleSetConfig>('ruleset.v1.json'),
    accounts: read<AccountMapConfig>('odoo-accounts.json'),
    descriptors: read<DescriptorConfig>('descriptors.json'),
    holidays: Object.values(holidayFile.holidays)
      .flat()
      .map((holiday) => holiday.date),
  };
}
