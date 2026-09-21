import type { SourceId } from '../domain/ids.js';
import type { SourceConnector } from './source-connector.js';

/**
 * Resolves a source id to its connector.
 *
 * The composition root builds it from the connectors it constructs; a new
 * source is wired there by hand, and added to the ingest loop of the run
 * pipeline, which lists its sources explicitly. There used to be a
 * config/sources.json that described sources declaratively; nothing ever read
 * it, and a config file that is not loaded is documentation that drifts.
 */
export interface ConnectorRegistry {
  get(sourceId: SourceId): SourceConnector;
  ids(): readonly SourceId[];
}
