import type { SourceId } from '../domain/ids.js';
import type { SourceConnector } from './source-connector.js';

/**
 * Resolves a source id to its connector.
 *
 * The composition root builds it from the connectors it constructs, and the
 * run pipeline ingests every id it returns — so registering a connector is the
 * same as asking for it to be read. There used to be a
 * config/sources.json that described sources declaratively; nothing ever read
 * it, and a config file that is not loaded is documentation that drifts.
 */
export interface ConnectorRegistry {
  get(sourceId: SourceId): SourceConnector;
  ids(): readonly SourceId[];
}
